import type { WikiState } from "@/stores/wiki-store"
import { isStandaloneView, isResearchPanelVisible, isDeepWikiPanelVisible } from "./research-panel-nav"

export function getAppLayoutVisibility(
  activeView: WikiState["activeView"],
  researchPanelOpen: boolean,
  deepWikiPanelOpen: boolean,
): { showLeftPanel: boolean; hasRightPanel: boolean } {
  const isStandalone = isStandaloneView(activeView)
  return {
    showLeftPanel: !isStandalone,
    hasRightPanel:
      !isStandalone &&
      (isResearchPanelVisible(activeView, researchPanelOpen) ||
        isDeepWikiPanelVisible(activeView, deepWikiPanelOpen)),
  }
}
