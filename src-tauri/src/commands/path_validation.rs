//! Portable path-segment validation shared across write surfaces.
//!
//! Previously this logic lived inline in `agent/tools.rs` with the tool name
//! (`wiki.write_page`) hard-coded into every error string. That made it
//! unusable from other callers (the HTTP API drop endpoint) without either
//! duplicating the rules or leaking an unrelated tool name into API errors.
//!
//! The rules themselves are extracted here as a structured enum; each caller
//! maps the variant to its own user-facing wording. `agent::tools` preserves
//! its existing strings verbatim (locked by regression tests) by mapping the
//! enum back to the old phrasing.

/// A single path segment that failed portability validation.
///
/// Variants are ordered from cheapest to check to most specific. Callers
/// match exhaustively so adding a new failure mode is a compile error until
/// every caller handles it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortablePathError {
    Empty,
    TrailingSpaceOrDot,
    IllegalChar,
    WindowsReserved,
}

impl PortablePathError {
    /// The historical `wiki.write_page` wording, verbatim. Kept here so
    /// `agent::tools` does not drift from its pre-extraction messages.
    pub fn wiki_write_page_message(&self) -> &'static str {
        match self {
            Self::Empty => "wiki.write_page path contains an empty segment",
            Self::TrailingSpaceOrDot => {
                "wiki.write_page path contains a segment ending with a space or dot, which is not portable to Windows"
            }
            Self::IllegalChar => {
                "wiki.write_page path contains characters that are invalid on Windows"
            }
            Self::WindowsReserved => "wiki.write_page path uses a Windows reserved device name",
        }
    }

    /// The historical `workspace.write_file` wording, verbatim.
    pub fn workspace_write_file_message(&self) -> String {
        self.wiki_write_page_message()
            .replace("wiki.write_page", "workspace.write_file")
    }
}

/// Validate a single path segment for cross-platform portability.
///
/// Rules (unchanged from the original `validate_portable_path_segment`):
/// - non-empty
/// - does not end with a space or dot (Windows trailing-dot/space hazard)
/// - contains no `< > : " | ? *` and no control characters (`<= \u{1f}`)
/// - stem is not a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9,
///   LPT1-9), compared case-insensitively after trimming a trailing space
pub fn validate_portable_path_segment(segment: &str) -> Result<(), PortablePathError> {
    if segment.is_empty() {
        return Err(PortablePathError::Empty);
    }
    if segment.ends_with([' ', '.']) {
        return Err(PortablePathError::TrailingSpaceOrDot);
    }
    if segment
        .chars()
        .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') || ch <= '\u{1f}')
    {
        return Err(PortablePathError::IllegalChar);
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err(PortablePathError::WindowsReserved);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_segment() {
        assert_eq!(validate_portable_path_segment("reviewer"), Ok(()));
        assert_eq!(validate_portable_path_segment("a-b_c.md"), Ok(()));
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(
            validate_portable_path_segment(""),
            Err(PortablePathError::Empty)
        );
    }

    #[test]
    fn rejects_trailing_space_or_dot() {
        assert_eq!(
            validate_portable_path_segment("ab."),
            Err(PortablePathError::TrailingSpaceOrDot)
        );
        assert_eq!(
            validate_portable_path_segment("ab "),
            Err(PortablePathError::TrailingSpaceOrDot)
        );
    }

    #[test]
    fn rejects_illegal_chars() {
        for bad in ["a:b", "a<b", "a>b", "a\"b", "a|b", "a?b", "a*b"] {
            assert_eq!(
                validate_portable_path_segment(bad),
                Err(PortablePathError::IllegalChar),
                "{bad}"
            );
        }
        // control char
        assert_eq!(
            validate_portable_path_segment("a\u{1}b"),
            Err(PortablePathError::IllegalChar)
        );
    }

    #[test]
    fn rejects_windows_reserved() {
        for bad in [
            "CON", "PRN", "AUX", "NUL", "con", "Com1", "LPT9", "CON.txt", "nul.md",
        ] {
            assert_eq!(
                validate_portable_path_segment(bad),
                Err(PortablePathError::WindowsReserved),
                "{bad}"
            );
        }
    }

    #[test]
    fn wiki_wording_matches_extracted_messages() {
        // Lock the exact wording the regression tests in agent::tools rely on.
        assert_eq!(
            PortablePathError::Empty.wiki_write_page_message(),
            "wiki.write_page path contains an empty segment"
        );
        assert!(PortablePathError::TrailingSpaceOrDot
            .wiki_write_page_message()
            .contains("ending with a space or dot"));
        assert!(PortablePathError::IllegalChar
            .wiki_write_page_message()
            .contains("invalid on Windows"));
        assert!(PortablePathError::WindowsReserved
            .wiki_write_page_message()
            .contains("Windows reserved device name"));
    }

    #[test]
    fn workspace_wording_substitutes_tool_name() {
        assert_eq!(
            PortablePathError::Empty.workspace_write_file_message(),
            "workspace.write_file path contains an empty segment"
        );
    }
}
