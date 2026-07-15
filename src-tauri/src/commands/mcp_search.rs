//! MCP (Model Context Protocol) Streamable HTTP source for Deep Research.
//!
//! Mirrors the shape of `deepwiki_search.rs` (single Tauri command, `panic_guard`
//! wrapper, `tokio::time::timeout` over the whole exchange) but implements the
//! MCP 2025-11-25 Streamable HTTP protocol directly: `initialize` ->
//! `notifications/initialized` -> `tools/call`, with an independent incremental
//! SSE decoder (JSON-RPC over SSE is not the same shape as DeepWiki's
//! `data: {content}` lines).
//!
//! Security: errors returned to the frontend are sanitized (service name +
//! phase + HTTP status + truncated summary; never headers / full URL / server
//! body). Success result URLs use an internal `mcp://source/<id>/<index>` form
//! that never carries the endpoint (which may contain userinfo/query tokens).

use std::collections::HashMap;
use std::time::Duration;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::external_search::ExternalSearchResult;
use crate::panic_guard::run_guarded_async;

/// MCP service config as sent by the frontend (`Required<McpServiceConfig>`,
/// camelCase). Mirrors `McpServiceConfig` in `src/stores/wiki-store.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServiceConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub endpoint: String,
    pub auth_headers: Option<HashMap<String, String>>,
    pub tool_name: String,
    pub argument_template: String,
    pub timeout_secs: u64,
    pub max_snippet_chars: usize,
}

/// Wire shape returned to the frontend. Mirrors `McpServiceSearchResult` in
/// `src/lib/mcp-source.ts`. A single tool call may yield multiple `text`
/// content items, each becomes its own `ExternalSearchResult`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServiceSearchResult {
    pub service_id: String,
    pub service_name: String,
    pub results: Vec<ExternalSearchResult>,
}

#[tauri::command]
pub async fn mcp_service_search(
    topic: String,
    service: McpServiceConfig,
) -> Result<McpServiceSearchResult, String> {
    run_guarded_async("mcp_service_search", async move {
        run_mcp_service_search(&topic, &service).await
    })
    .await
}

async fn run_mcp_service_search(
    topic: &str,
    service: &McpServiceConfig,
) -> Result<McpServiceSearchResult, String> {
    if !service.enabled {
        return Err(sanitize_err(service, "config", "service is disabled"));
    }
    if service.endpoint.trim().is_empty() {
        return Err(sanitize_err(service, "config", "endpoint is not configured"));
    }
    if service.tool_name.trim().is_empty() {
        return Err(sanitize_err(service, "config", "toolName is not configured"));
    }
    if service.timeout_secs == 0 {
        return Err(sanitize_err(service, "config", "timeoutSecs is not configured"));
    }

    let timeout = Duration::from_secs(service.timeout_secs);
    tokio::time::timeout(timeout, initialize_session_and_call(topic, service))
        .await
        .map_err(|_| {
            sanitize_err(
                service,
                "timeout",
                &format!("timed out after {}s", service.timeout_secs),
            )
        })?
}

/// `initialize` -> `notifications/initialized` -> `tools/call`, with a single
/// 404-session-expired retry (only when a session was actually established).
/// Shares the caller's total timeout deadline.
async fn initialize_session_and_call(
    topic: &str,
    service: &McpServiceConfig,
) -> Result<McpServiceSearchResult, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| sanitize_err(service, "config", &format!("client build failed: {e}")))?;

    let arguments = render_arguments(&service.argument_template, topic, service)?;

    match call_with_session(&client, service, &arguments).await {
        Ok(result) => Ok(result),
        Err(McpError::SessionExpired) => {
            // Retry exactly once: re-initialize -> initialized -> tools/call.
            // If this also fails (including another 404), surface the error.
            call_with_session(&client, service, &arguments)
                .await
                .map(|r| r)
                .map_err(|e| mcp_error_to_string(service, &e, "tools-call"))
        }
        Err(e) => Err(mcp_error_to_string(service, &e, "tools-call")),
    }
}

/// One full initialize -> initialized -> tools/call pass.
async fn call_with_session(
    client: &reqwest::Client,
    service: &McpServiceConfig,
    arguments: &Value,
) -> Result<McpServiceSearchResult, McpError> {
    let (session_id, protocol_version) = do_initialize(client, service).await?;
    do_initialized(client, service, &session_id, &protocol_version).await?;
    let result = do_tools_call(client, service, arguments, &session_id, &protocol_version).await?;
    Ok(build_results(service, result))
}

// ── JSON-RPC request ids ────────────────────────────────────────────────────
const ID_INITIALIZE: i64 = 1;
const ID_TOOLS_CALL: i64 = 2;

async fn do_initialized(
    client: &reqwest::Client,
    service: &McpServiceConfig,
    session_id: &Option<String>,
    protocol_version: &str,
) -> Result<(), McpError> {
    let body = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    let resp = build_request(client, service, body, session_id.as_deref(), Some(protocol_version))
        .send()
        .await
        .map_err(|e| McpError::Other(sanitize_err(service, "initialized", &format!("send failed: {e}"))))?;
    let status = resp.status();
    if !status.is_success() {
        // 404 here, if we had a session, is session-expired (retryable).
        if status.as_u16() == 404 && session_id.is_some() {
            return Err(McpError::SessionExpired);
        }
        return Err(McpError::Other(sanitize_err(
            service,
            "initialized",
            &format!("HTTP {}", status.as_u16()),
        )));
    }
    // initialized typically returns 202 + empty body; no envelope to parse.
    Ok(())
}

async fn do_tools_call(
    client: &reqwest::Client,
    service: &McpServiceConfig,
    arguments: &Value,
    session_id: &Option<String>,
    protocol_version: &str,
) -> Result<Value, McpError> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": ID_TOOLS_CALL,
        "method": "tools/call",
        "params": {
            "name": service.tool_name,
            "arguments": arguments,
        }
    });
    let resp = build_request(client, service, body, session_id.as_deref(), Some(protocol_version))
        .send()
        .await
        .map_err(|e| McpError::Other(sanitize_err(service, "tools-call", &format!("send failed: {e}"))))?;
    let status = resp.status();
    if !status.is_success() {
        if status.as_u16() == 404 && session_id.is_some() {
            return Err(McpError::SessionExpired);
        }
        return Err(McpError::Other(sanitize_err(
            service,
            "tools-call",
            &format!("HTTP {}", status.as_u16()),
        )));
    }
    let envelope =
        read_envelope(resp, &json!(ID_TOOLS_CALL), service, "tools-call").await?;
    // Top-level JSON-RPC error (protocol-level).
    if let Some(err) = envelope.get("error") {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("tool call error");
        return Err(McpError::Other(sanitize_err(
            service,
            "tools-call",
            &redact_text(msg, service),
        )));
    }
    let result = envelope
        .get("result")
        .ok_or_else(|| McpError::Other(sanitize_err(service, "tools-call", "missing result")))?;
    // tool business error: isError == true.
    if result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let content_text = collect_text(result);
        let summary = redact_text(&content_text, service);
        return Err(McpError::Other(sanitize_err(
            service,
            "tools-call",
            &truncate(&summary, 200),
        )));
    }
    Ok(result.clone())
}

// ── Request builder (reserved-header blacklist) ─────────────────────────────

fn build_request(
    client: &reqwest::Client,
    service: &McpServiceConfig,
    body: Value,
    session_id: Option<&str>,
    protocol_version: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut req = client
        .post(service.endpoint.trim())
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .json(&body);

    // User authHeaders (filtered: reserved headers never overwritten).
    if let Some(headers) = &service.auth_headers {
        for (name, value) in headers {
            if is_reserved_header(name) {
                continue;
            }
            // Skip headers with control chars in name/value (would be invalid).
            if name.chars().any(|c| c == '\n' || c == '\r')
                || value.chars().any(|c| c == '\n' || c == '\r')
            {
                continue;
            }
            req = req.header(name, value);
        }
    }

    // Protocol headers (forced, post-authHeaders so they cannot be overridden).
    if let (Some(sid), _) = (session_id, ()) {
        if !sid.is_empty() {
            req = req.header("Mcp-Session-Id", sid);
        }
    }
    if let Some(pv) = protocol_version {
        if !pv.is_empty() {
            req = req.header("MCP-Protocol-Version", pv);
        }
    }
    req
}

fn is_reserved_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "content-type" | "accept"
            | "mcp-session-id" | "mcp-protocol-version"
    )
}

// ── Envelope reader (JSON vs SSE) ───────────────────────────────────────────

async fn read_envelope(
    response: reqwest::Response,
    expected_id: &Value,
    service: &McpServiceConfig,
    phase: &str,
) -> Result<Value, McpError> {
    let status = response.status();
    if !status.is_success() {
        if status.as_u16() == 404 {
            // Caller decides retryability based on session presence.
            return Err(McpError::SessionExpired);
        }
        return Err(McpError::Other(sanitize_err(
            service,
            phase,
            &format!("HTTP {}", status.as_u16()),
        )));
    }
    let media = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();

    match media.as_str() {
        "application/json" => {
            let v: Value = response
                .json()
                .await
                .map_err(|e| McpError::Other(sanitize_err(service, phase, &format!("bad json: {e}"))))?;
            check_envelope(&v, expected_id, service, phase)
        }
        "text/event-stream" => {
            let mut stream = response.bytes_stream();
            let mut decoder = SseDecoder::new();
            while let Some(chunk_result) = stream.next().await {
                let bytes = chunk_result
                    .map_err(|e| McpError::Other(sanitize_err(service, phase, &format!("stream error: {e}"))))?;
                for payload in decoder.feed(&bytes) {
                    if let Some(v) = parse_envelope_payload(&payload) {
                        if matches_id(&v, expected_id) {
                            return check_envelope(&v, expected_id, service, phase);
                        }
                        // notification / unrelated id: ignore, keep scanning.
                    }
                }
            }
            for payload in decoder.finish() {
                if let Some(v) = parse_envelope_payload(&payload) {
                    if matches_id(&v, expected_id) {
                        return check_envelope(&v, expected_id, service, phase);
                    }
                }
            }
            Err(McpError::Other(sanitize_err(
                service,
                phase,
                "no matching response in SSE stream",
            )))
        }
        _ => Err(McpError::Other(sanitize_err(
            service,
            phase,
            &format!("unsupported content-type: {media}"),
        ))),
    }
}

fn check_envelope(
    v: &Value,
    expected_id: &Value,
    service: &McpServiceConfig,
    phase: &str,
) -> Result<Value, McpError> {
    if v.get("jsonrpc").and_then(|x| x.as_str()) != Some("2.0") {
        return Err(McpError::Other(sanitize_err(service, phase, "not jsonrpc 2.0")));
    }
    // Top-level error first (protocol-level).
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("error");
        return Err(McpError::Other(sanitize_err(
            service,
            phase,
            &redact_text(msg, service),
        )));
    }
    if !matches_id(v, expected_id) {
        return Err(McpError::Other(sanitize_err(service, phase, "id mismatch")));
    }
    Ok(v.clone())
}

fn parse_envelope_payload(payload: &str) -> Option<Value> {
    if payload == "[DONE]" {
        return None;
    }
    serde_json::from_str::<Value>(payload).ok()
}

fn matches_id(v: &Value, expected: &Value) -> bool {
    v.get("id").map_or(false, |id| id == expected)
}

// ── Incremental SSE decoder ─────────────────────────────────────────────────
//
// Independent of deepwiki_search.rs's line parser: SSE events are delimited by
// blank lines; multiple `data:` lines within one event are joined with "\n";
// both `data:` and `data: ` are accepted. Returns full event payloads (the
// joined data string), so the caller can parse JSON-RPC envelopes and match by
// id without waiting for [DONE].

struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    /// Feed a chunk; return any complete events (terminated by a blank line).
    fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        loop {
            let Some(blk) = find_event_boundary(&self.buffer) else {
                break;
            };
            // blk = (start of blank line, total length including the blank line)
            let event_bytes = self.buffer[..blk.event_end].to_vec();
            self.buffer.drain(..blk.consume_to);
            events.push(join_data_lines(&event_bytes));
        }
        events
    }

    /// Flush any trailing event that never received a terminating blank line.
    fn finish(&mut self) -> Vec<String> {
        if self.buffer.is_empty() {
            return Vec::new();
        }
        let trailing = std::mem::take(&mut self.buffer);
        // Only emit if it contains a `data:` line.
        let joined = join_data_lines(&trailing);
        if joined.is_empty() {
            Vec::new()
        } else {
            vec![joined]
        }
    }
}

struct Boundary {
    event_end: usize,
    consume_to: usize,
}

/// Find the next blank-line event boundary. A blank line is `\n\n`, `\r\n\r\n`,
/// or a lone `\n` after another `\n`. Returns the end of the event content
/// (exclusive) and how many bytes to consume (including the blank line).
fn find_event_boundary(buf: &[u8]) -> Option<Boundary> {
    let mut i = 0;
    while i + 1 < buf.len() {
        if buf[i] == b'\n' && buf[i + 1] == b'\n' {
            return Some(Boundary {
                event_end: i,
                consume_to: i + 2,
            });
        }
        if i + 3 < buf.len()
            && buf[i] == b'\r'
            && buf[i + 1] == b'\n'
            && buf[i + 2] == b'\r'
            && buf[i + 3] == b'\n'
        {
            return Some(Boundary {
                event_end: i,
                consume_to: i + 4,
            });
        }
        i += 1;
    }
    None
}

/// Join all `data:` lines of one event with "\n". Lines that are not `data:`
/// (event name, id, retry, comments) are ignored.
fn join_data_lines(event_bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(event_bytes);
    let mut data_parts: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix("data:") {
            // Accept both "data:value" and "data: value".
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            data_parts.push(rest);
        }
    }
    data_parts.join("\n")
}

// ── Argument template ───────────────────────────────────────────────────────

/// Render `{{topic}}` as a complete JSON string value (serialized with
/// `serde_json::to_string`, so quotes/newlines are escaped). Reject templates
/// where the placeholder is wrapped in quotes (`"{{topic}}"`), which would
/// double-quote and break JSON.
fn render_arguments(
    template: &str,
    topic: &str,
    service: &McpServiceConfig,
) -> Result<Value, String> {
    if template.contains("\"{{topic}}\"") {
        return Err(sanitize_err(
            service,
            "config",
            "argumentTemplate wraps {{topic}} in quotes; use {{topic}} without surrounding quotes (it expands to a JSON string value)",
        ));
    }
    let topic_json = serde_json::to_string(topic)
        .map_err(|e| sanitize_err(service, "config", &format!("topic encode failed: {e}")))?;
    let rendered = template.replace("{{topic}}", &topic_json);
    let value: Value = serde_json::from_str(&rendered).map_err(|_| {
        sanitize_err(
            service,
            "config",
            "argumentTemplate does not produce a valid JSON object after substitution",
        )
    })?;
    if !value.is_object() {
        return Err(sanitize_err(
            service,
            "config",
            "argumentTemplate must produce a JSON object",
        ));
    }
    Ok(value)
}

// ── Result building ─────────────────────────────────────────────────────────

fn build_results(service: &McpServiceConfig, result: Value) -> McpServiceSearchResult {
    let mut results = Vec::new();
    if let Some(content) = result.get("content").and_then(|v| v.as_array()) {
        for (idx, item) in content.iter().enumerate() {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    results.push(ExternalSearchResult {
                        title: service.name.clone(),
                        url: format!(
                            "mcp://source/{}/{}",
                            percent_encode_path_segment(&service.id),
                            idx
                        ),
                        snippet: truncate(text, service.max_snippet_chars),
                        source: format!("MCP: {}", service.name),
                    });
                }
            }
        }
    }
    McpServiceSearchResult {
        service_id: service.id.clone(),
        service_name: service.name.clone(),
        results,
    }
}

fn collect_text(result: &Value) -> String {
    let mut out = String::new();
    if let Some(content) = result.get("content").and_then(|v| v.as_array()) {
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(text);
                }
            }
        }
    }
    out
}

// ── Sanitization / redaction ────────────────────────────────────────────────

#[derive(Debug)]
enum McpError {
    /// 404 received on a session-carrying request; retry once.
    SessionExpired,
    Other(String),
}

fn mcp_error_to_string(service: &McpServiceConfig, e: &McpError, phase: &str) -> String {
    match e {
        McpError::SessionExpired => sanitize_err(service, phase, "session expired after retry"),
        McpError::Other(s) => s.clone(),
    }
}

/// Build a sanitized error: `{service_name} {phase}: {summary}`. Never includes
/// headers, full URL (with userinfo/query), or raw server body.
fn sanitize_err(service: &McpServiceConfig, phase: &str, summary: &str) -> String {
    format!(
        "{} {}: {}",
        service.name,
        phase,
        truncate(summary, 200)
    )
}

/// Replace sensitive field values and configured authHeader values with
/// `[redacted]`. Field-name based: if a token-looking key appears, redact its
/// value. Also redacts any value equal to a configured authHeader value.
fn redact_text(text: &str, service: &McpServiceConfig) -> String {
    let sensitive_keys = [
        "token",
        "authorization",
        "api_key",
        "apikey",
        "password",
        "secret",
    ];
    let mut out = text.to_string();
    // Redact configured authHeader *values* wherever they appear.
    if let Some(headers) = &service.auth_headers {
        for (_k, v) in headers {
            if v.len() >= 4 && !v.is_empty() {
                out = out.replace(v, "[redacted]");
            }
        }
    }
    // Best-effort: redact `"<sensitive_key>":"<value>"` patterns.
    for key in sensitive_keys {
        for quote in ['"', '\''] {
            let pat = format!("{quote}{key}{quote}");
            if let Some(start) = out.find(&pat) {
                if let Some(value_start) = out[start..].find(':') {
                    let vs = start + value_start + 1;
                    if let Some(rest) = out.get(vs..) {
                        let trimmed = rest.trim_start();
                        let leading = vs + (rest.len() - trimmed.len());
                        if let Some(qch) = trimmed.chars().next() {
                            if qch == '"' || qch == '\'' {
                                let after_q = leading + 1;
                                if let Some(end_rel) = out[after_q..].find(qch) {
                                    let end = after_q + end_rel;
                                    out.replace_range(leading..=end, "[redacted]");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut result: String = s.chars().take(max_chars).collect();
    result.push('…');
    result
}

/// percent-encode a URL path segment: keep only RFC 3986 unreserved
/// `[A-Za-z0-9._~-]`, everything else (including `/`, `?`, `#`, `@`, `:`, `%`,
/// Unicode, spaces) becomes `%HH` by UTF-8 byte.
fn percent_encode_path_segment(s: &str) -> String {
    let mut out = String::new();
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `initialize` request -> capture `Mcp-Session-Id` response header (if any) +
/// negotiate `protocolVersion` (must equal what we sent). Returns the session
/// id (optional: Streamable HTTP does not always issue one) and protocol version.
async fn do_initialize(
    client: &reqwest::Client,
    service: &McpServiceConfig,
) -> Result<(Option<String>, String), McpError> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": ID_INITIALIZE,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "llm-wiki", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    let resp = build_request(client, service, body, None, None)
        .send()
        .await
        .map_err(|e| McpError::Other(sanitize_err(service, "initialize", &format!("send failed: {e}"))))?;
    let session_id = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let envelope = read_envelope(resp, &json!(ID_INITIALIZE), service, "initialize").await?;
    let result = envelope
        .get("result")
        .ok_or_else(|| McpError::Other(sanitize_err(service, "initialize", "missing result")))?;
    let protocol_version = result
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "2025-11-25".to_string());
    if protocol_version != "2025-11-25" {
        return Err(McpError::Other(sanitize_err(
            service,
            "initialize",
            &format!("unsupported protocolVersion: {protocol_version}"),
        )));
    }
    Ok((session_id, protocol_version))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc() -> McpServiceConfig {
        McpServiceConfig {
            id: "abc".to_string(),
            name: "demo".to_string(),
            enabled: true,
            endpoint: "https://example.test/mcp".to_string(),
            auth_headers: None,
            tool_name: "search".to_string(),
            argument_template: r#"{"query": {{topic}}}"#.to_string(),
            timeout_secs: 120,
            max_snippet_chars: 4000,
        }
    }

    // ── argument template ──

    #[test]
    fn template_renders_topic_as_json_string() {
        let v = render_arguments(r#"{"query": {{topic}}}"#, "hello \"world\"", &svc()).unwrap();
        assert_eq!(v["query"], "hello \"world\"");
    }

    #[test]
    fn template_rejects_quoted_placeholder() {
        let err = render_arguments(r#"{"query": "{{topic}}"}"#, "x", &svc()).unwrap_err();
        assert!(err.contains("quotes"), "{err}");
    }

    #[test]
    fn template_escapes_newlines_in_topic() {
        let v = render_arguments(r#"{"q": {{topic}}}"#, "line1\nline2", &svc()).unwrap();
        assert_eq!(v["q"], "line1\nline2");
    }

    #[test]
    fn template_must_produce_object() {
        let err = render_arguments("{{topic}}", "x", &svc()).unwrap_err();
        assert!(err.contains("object"), "{err}");
    }

    // ── SSE decoder ──

    fn decode_all(input: &[u8]) -> Vec<String> {
        let mut d = SseDecoder::new();
        let mut out = d.feed(input);
        out.extend(d.finish());
        out
    }

    #[test]
    fn sse_single_data_line() {
        let ev = decode_all(b"data: {\"id\":2,\"jsonrpc\":\"2.0\",\"result\":{}}\n\n");
        assert_eq!(ev, vec![r#"{"id":2,"jsonrpc":"2.0","result":{}}"#]);
    }

    #[test]
    fn sse_multi_data_lines_joined() {
        let ev = decode_all(b"data: {\"id\":2,\ndata: \"jsonrpc\":\"2.0\",\ndata: \"result\":{}}\n\n");
        assert_eq!(ev.len(), 1);
        assert!(ev[0].contains("\"result\":{}"));
    }

    #[test]
    fn sse_accepts_no_space_after_data() {
        let ev = decode_all(b"data:{\"id\":2}\n\n");
        assert_eq!(ev, vec![r#"{"id":2}"#]);
    }

    #[test]
    fn sse_handles_crlf() {
        let ev = decode_all(b"data: {\"id\":2}\r\n\r\n");
        assert_eq!(ev, vec![r#"{"id":2}"#]);
    }

    #[test]
    fn sse_ignores_notifications_keeps_matching() {
        let input = b"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n\n";
        let ev = decode_all(input);
        assert_eq!(ev.len(), 2);
        assert!(ev[1].contains(r#""id":2"#));
    }

    #[test]
    fn sse_chunk_boundary_across_data_line() {
        let mut d = SseDecoder::new();
        let mut out = d.feed(b"data: {\"id\":");
        out.extend(d.feed(b"2}\n\n"));
        out.extend(d.finish());
        assert_eq!(out, vec![r#"{"id":2}"#]);
    }

    #[test]
    fn sse_trailing_event_without_blank_line() {
        let mut d = SseDecoder::new();
        let mut out = d.feed(b"data: {\"id\":2}\n");
        out.extend(d.finish());
        assert_eq!(out, vec![r#"{"id":2}"#]);
    }

    // ── envelope matching ──

    #[test]
    fn matches_id_filters_notifications() {
        let v: Value = serde_json::from_str(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#).unwrap();
        assert!(matches_id(&v, &json!(2)));
        let n: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"notifications/progress"}"#).unwrap();
        assert!(!matches_id(&n, &json!(2)));
    }

    #[test]
    fn check_envelope_surfaces_top_level_error() {
        let v: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"boom"}}"#,
        )
        .unwrap();
        let err = check_envelope(&v, &json!(2), &svc(), "tools-call").unwrap_err();
        match err {
            McpError::Other(s) => assert!(s.contains("demo"), "{s}"),
            _ => panic!("expected Other"),
        }
    }

    // ── reserved header blacklist ──

    #[test]
    fn reserved_headers_detected() {
        assert!(is_reserved_header("Mcp-Session-Id"));
        assert!(is_reserved_header("content-type"));
        assert!(is_reserved_header("Accept"));
        assert!(!is_reserved_header("Authorization"));
    }

    // ── result url / dedupe ──

    #[test]
    fn result_url_is_internal_and_unique() {
        let result: Value = serde_json::from_str(
            r#"{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}"#,
        )
        .unwrap();
        let built = build_results(&svc(), result);
        assert_eq!(built.results.len(), 2);
        assert_eq!(built.results[0].url, "mcp://source/abc/0");
        assert_eq!(built.results[1].url, "mcp://source/abc/1");
        assert!(built.results[0].url != built.results[1].url);
    }

    #[test]
    fn result_url_encodes_special_id_chars() {
        let mut s = svc();
        s.id = "a/b@c:d".to_string();
        let result: Value =
            serde_json::from_str(r#"{"content":[{"type":"text","text":"x"}]}"#).unwrap();
        let built = build_results(&s, result);
        // `/`, `@`, `:` must be percent-encoded; only unreserved kept.
        // (`mcp://` scheme `:` is expected; the id's `:` becomes `%3A`, verified by the eq.)
        assert!(!built.results[0].url.contains('@'));
        assert_eq!(built.results[0].url, "mcp://source/a%2Fb%40c%3Ad/0");
    }

    // ── sanitization / redaction ──

    #[test]
    fn error_message_omits_endpoint() {
        let e = sanitize_err(&svc(), "tools-call", "HTTP 500");
        assert!(e.contains("demo"));
        assert!(e.contains("tools-call"));
        assert!(!e.contains("example.test"));
    }

    #[test]
    fn redact_strips_authheader_values() {
        let mut s = svc();
        s.auth_headers = Some(HashMap::from([(
            "Authorization".to_string(),
            "Bearer s3cr3t-token".to_string(),
        )]));
        let red = redact_text("echoed: Bearer s3cr3t-token here", &s);
        assert!(red.contains("[redacted]"));
        assert!(!red.contains("s3cr3t-token"));
    }

    // ── truncate ──

    #[test]
    fn truncate_counts_chars() {
        assert_eq!(truncate("一二三四五", 3), "一二三…");
        assert_eq!(truncate("abc", 3), "abc");
    }

    // ── percent encode roundtrip ──

    #[test]
    fn percent_encode_unreserved_only_and_roundtrips_via_decode() {
        let id = "safe_id-1.2~3";
        assert_eq!(percent_encode_path_segment(id), id);
        let encoded = percent_encode_path_segment("a b/c@d:e");
        // Decode back: %HH -> bytes.
        let mut decoded = String::new();
        let bytes = encoded.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
                let byte = u8::from_str_radix(hex, 16).unwrap();
                decoded.push(byte as char);
                i += 3;
            } else {
                decoded.push(bytes[i] as char);
                i += 1;
            }
        }
        assert_eq!(decoded, "a b/c@d:e");
    }
}
