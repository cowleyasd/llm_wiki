use std::path::PathBuf;
use std::time::Duration;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::panic_guard::run_guarded_async;

/// Wire shape returned to the frontend. Mirrors `DeepWikiSearchResult` in
/// `src/lib/deepwiki-source.ts`. The frontend wraps this single long-form
/// answer into a `WebSearchResult` for the synthesis stage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepWikiSearchResult {
    pub content: String,
    pub space_url: String,
}

/// DeepWiki source config as sent by the frontend (`Required<DeepWikiSourceConfig>`,
/// camelCase). `assemblyInstruction` is consumed by the TS assembly step and
/// ignored here (serde skips unknown fields by default).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepWikiConfig {
    pub enabled: bool,
    pub base_url: String,
    pub token: String,
    pub space_id: String,
    pub model: String,
    pub branch: String,
    pub timeout_secs: u64,
    pub max_snippet_chars: usize,
}

#[tauri::command]
pub async fn deepwiki_search(
    prompt: String,
    config: DeepWikiConfig,
) -> Result<DeepWikiSearchResult, String> {
    run_guarded_async("deepwiki_search", async move {
        run_deepwiki_search(&prompt, &config).await
    })
    .await
}

async fn run_deepwiki_search(
    prompt: &str,
    config: &DeepWikiConfig,
) -> Result<DeepWikiSearchResult, String> {
    if prompt.trim().is_empty() {
        return Err("DeepWiki prompt is empty".to_string());
    }
    if !config.enabled {
        return Err("DeepWiki source is disabled".to_string());
    }
    if config.base_url.trim().is_empty() {
        return Err("DeepWiki baseUrl is not configured".to_string());
    }
    if config.space_id.trim().is_empty() {
        return Err("DeepWiki spaceId is not configured".to_string());
    }
    if config.model.trim().is_empty() {
        return Err("DeepWiki model is not configured".to_string());
    }
    if config.timeout_secs == 0 {
        return Err("DeepWiki timeoutSecs is not configured".to_string());
    }

    let token = resolve_token(config).await?;
    let session_id = Uuid::new_v4().to_string();
    let space_url = build_space_url(&config.base_url, &config.space_id);
    let endpoint = format!(
        "{}/v1/chat/completions",
        config.base_url.trim_end_matches('/')
    );

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Failed to build DeepWiki client: {e}"))?;

    // Note: max_snippet_chars is intentionally NOT used to truncate content
    // here. DeepWiki content is written verbatim as a source file for ingest,
    // so the full text must reach the frontend. The field remains in the
    // config only for the hasConfiguredDeepWiki (>0) validity check.
    let timeout = Duration::from_secs(config.timeout_secs);

    // Wrap the entire send + SSE stream in a timeout so a hung connection or
    // a server that keeps the stream open after [DONE] cannot block forever.
    // Cancellation: dropping this future drops the reqwest request, closing
    // the underlying HTTP connection.
    let fut = async {
        let response = client
            .post(&endpoint)
            .header("X-User-Token", &token)
            .header("Content-Type", "application/json")
            .json(&json!({
                "content": prompt,
                "branch": config.branch,
                "model": config.model,
                "space_id": config.space_id,
                "session_id": session_id,
            }))
            .send()
            .await
            .map_err(|e| format!("DeepWiki request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!(
                "DeepWiki HTTP {status}: {}",
                truncate_string(&text, 300)
            ));
        }

        // Incremental SSE parse: read bytes_stream chunk by chunk, split on
        // newlines, and return as soon as `data: [DONE]` is seen. Using
        // bytes_stream (not response.text()) is required because the server
        // may keep the connection open after [DONE]; response.text() would
        // then block until the overall timeout on every request.
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut content = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result
                .map_err(|e| format!("DeepWiki stream error: {e}"))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(nl) = buffer.find('\n') {
                // Own the line so the borrow on `buffer` ends before we
                // reassign it with the remaining tail.
                let line: String = buffer[..nl].trim_end_matches('\r').to_string();
                buffer = buffer[nl + 1..].to_string();

                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    return Ok(DeepWikiSearchResult {
                        // Do not truncate: DeepWiki content is written verbatim
                        // as a source file for ingest (entities extracted from
                        // the full text). maxSnippetChars is kept in the config
                        // only for the hasConfiguredDeepWiki > 0 check.
                        content: content.clone(),
                        space_url: space_url.clone(),
                    });
                }
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    if let Some(text) = parsed.get("content").and_then(|v| v.as_str()) {
                        content.push_str(text);
                    }
                }
            }
        }

        // Stream ended (connection closed) without an explicit [DONE].
        // Return whatever was accumulated; empty content is treated as a
        // failure by the frontend. Content is NOT truncated — see the
        // [DONE] branch above for rationale.
        Ok(DeepWikiSearchResult {
            content,
            space_url,
        })
    };

    tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| {
            format!(
                "DeepWiki request timed out after {}s",
                config.timeout_secs
            )
        })?
        .map(|result| result)
}

/// Resolve the DeepWiki user token: config field first, then fall back to
/// `~/.claude/deepwiki.config.json` (the same file the deepwiki CLI skill
/// reads). The env-registry lookup the CLI performs is intentionally not
/// replicated.
async fn resolve_token(config: &DeepWikiConfig) -> Result<String, String> {
    if !config.token.is_empty() {
        return Ok(config.token.clone());
    }
    if let Some(home) = home_dir() {
        let path = home.join(".claude").join("deepwiki.config.json");
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            if let Ok(parsed) = serde_json::from_str::<Value>(&content) {
                if let Some(token) = parsed.get("user_token").and_then(|v| v.as_str()) {
                    if !token.is_empty() {
                        return Ok(token.to_string());
                    }
                }
            }
        }
    }
    Err(
        "DeepWiki token missing. Set it in Settings or in ~/.claude/deepwiki.config.json"
            .to_string(),
    )
}

fn build_space_url(base_url: &str, space_id: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let root = trimmed.trim_end_matches("/api/open");
    format!("{root}/space/{space_id}")
}

fn truncate_string(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut result: String = s.chars().take(max_chars).collect();
    result.push('…');
    result
}

/// Cross-platform home directory resolution. Mirrors the logic in
/// `agent::skills::home_dir` without reaching across modules.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                let mut home = PathBuf::from(drive);
                home.push(path);
                Some(home.into_os_string())
            })
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_url_strips_api_open_suffix() {
        assert_eq!(
            build_space_url("https://example.com/api/open", "abc-123"),
            "https://example.com/space/abc-123"
        );
        // No /api/open suffix -> root is the trimmed base url.
        assert_eq!(
            build_space_url("https://example.com/", "xyz"),
            "https://example.com/space/xyz"
        );
    }

    #[test]
    fn truncate_string_counts_chars_not_bytes() {
        // Each CJK char is 3 bytes in UTF-8; char-count must be the limit.
        let s = "一二三四五";
        assert_eq!(truncate_string(s, 3), "一二三…");
        assert_eq!(truncate_string(s, 10), s);
    }

    #[test]
    fn deepwiki_config_deserializes_camel_case() {
        let json = serde_json::json!({
            "enabled": true,
            "baseUrl": "https://x/api/open",
            "token": "tok",
            "spaceId": "sp",
            "model": "m",
            "branch": "b",
            "assemblyInstruction": "ignored-by-rust",
            "timeoutSecs": 120,
            "maxSnippetChars": 4000
        });
        let cfg: DeepWikiConfig = serde_json::from_value(json).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.base_url, "https://x/api/open");
        assert_eq!(cfg.timeout_secs, 120);
        assert_eq!(cfg.max_snippet_chars, 4000);
    }
}
