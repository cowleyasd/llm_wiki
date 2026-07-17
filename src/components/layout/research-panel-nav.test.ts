import { describe, expect, it } from "vitest"
import {
  isResearchPanelVisible,
  nextResearchPanelNavState,
} from "./research-panel-nav"

describe("research panel nav state", () => {
  it("switches non-wiki views to wiki and opens the panel", () => {
    expect(nextResearchPanelNavState("chat", false)).toEqual({
      activeView: "wiki",
      researchPanelOpen: true,
    })
    expect(nextResearchPanelNavState("settings", true)).toEqual({
      activeView: "wiki",
      researchPanelOpen: true,
    })
    expect(nextResearchPanelNavState("skills", false)).toEqual({
      activeView: "wiki",
      researchPanelOpen: true,
    })
    // graph/review/etc. also switch to wiki when opening the panel
    expect(nextResearchPanelNavState("graph", false)).toEqual({
      activeView: "wiki",
      researchPanelOpen: true,
    })
    expect(nextResearchPanelNavState("review", false)).toEqual({
      activeView: "wiki",
      researchPanelOpen: true,
    })
  })

  it("toggles the panel on the wiki view without switching", () => {
    expect(nextResearchPanelNavState("wiki", false)).toEqual({
      activeView: "wiki",
      researchPanelOpen: true,
    })
    expect(nextResearchPanelNavState("wiki", true)).toEqual({
      activeView: "wiki",
      researchPanelOpen: false,
    })
  })

  it("only marks the panel visible on the wiki view", () => {
    expect(isResearchPanelVisible("chat", true)).toBe(false)
    expect(isResearchPanelVisible("skills", true)).toBe(false)
    expect(isResearchPanelVisible("settings", true)).toBe(false)
    expect(isResearchPanelVisible("graph", true)).toBe(false)
    expect(isResearchPanelVisible("review", true)).toBe(false)
    expect(isResearchPanelVisible("wiki", true)).toBe(true)
    expect(isResearchPanelVisible("wiki", false)).toBe(false)
  })
})
