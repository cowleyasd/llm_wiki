import type { WikiState } from "@/stores/wiki-store"

export function isStandaloneView(view: WikiState["activeView"]): boolean {
  return view === "chat" || view === "skills" || view === "settings"
}

export function isResearchPanelVisible(
  activeView: WikiState["activeView"],
  researchPanelOpen: boolean,
): boolean {
  // Research panel only renders on the wiki view. Other views
  // (graph/review/lint/sources/search/chat/skills/settings) need the right
  // column for PreviewPanel (e.g. graph node details), so the panel must not
  // occupy it there. The user opens it from the sidebar; on other views it
  // stays hidden.
  return researchPanelOpen && activeView === "wiki"
}

/**
 * DeepWiki panel only shows on the wiki view — same rationale as Research:
 * must not occupy the right column on graph/review/lint/sources/search.
 */
export function isDeepWikiPanelVisible(
  activeView: WikiState["activeView"],
  deepWikiPanelOpen: boolean,
): boolean {
  return deepWikiPanelOpen && activeView === "wiki"
}

export function nextResearchPanelNavState(
  activeView: WikiState["activeView"],
  researchPanelOpen: boolean,
): { activeView: WikiState["activeView"]; researchPanelOpen: boolean } {
  if (activeView !== "wiki") {
    // Opening the panel from any non-wiki view switches to wiki first (the
    // panel only renders there). Closing keeps the current view.
    return { activeView: "wiki", researchPanelOpen: true }
  }
  return { activeView, researchPanelOpen: !researchPanelOpen }
}
