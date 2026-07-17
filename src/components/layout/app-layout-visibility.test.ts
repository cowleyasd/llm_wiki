import { describe, expect, it } from "vitest"
import { getAppLayoutVisibility } from "./app-layout-visibility"

describe("getAppLayoutVisibility", () => {
  it("keeps chat standalone without project side panels", () => {
    // Chat owns its conversation list and reference preview area. It must not
    // also inherit the project knowledge/file panel used by workspace views.
    expect(getAppLayoutVisibility("chat", true, false)).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })

  it("keeps settings as a standalone view even when research panel is open", () => {
    expect(getAppLayoutVisibility("settings", true, false)).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })

  it("keeps skills as a standalone management view", () => {
    expect(getAppLayoutVisibility("skills", true, false)).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })

  it("shows the project side panel and optional research panel in workspace views", () => {
    expect(getAppLayoutVisibility("wiki", false, false)).toEqual({
      showLeftPanel: true,
      hasRightPanel: false,
    })
    // Research panel only renders on the wiki view.
    expect(getAppLayoutVisibility("wiki", true, false)).toEqual({
      showLeftPanel: true,
      hasRightPanel: true,
    })
    expect(getAppLayoutVisibility("search", true, false)).toEqual({
      showLeftPanel: true,
      hasRightPanel: false,
    })
    expect(getAppLayoutVisibility("graph", true, false)).toEqual({
      showLeftPanel: true,
      hasRightPanel: false,
    })
  })

  it("shows the right panel when the DeepWiki panel is open", () => {
    expect(getAppLayoutVisibility("wiki", false, true)).toEqual({
      showLeftPanel: true,
      hasRightPanel: true,
    })
    // DeepWiki panel only renders on the wiki view, like Research.
    expect(getAppLayoutVisibility("graph", false, true)).toEqual({
      showLeftPanel: true,
      hasRightPanel: false,
    })
    // Standalone views still hide the right panel even with DeepWiki open.
    expect(getAppLayoutVisibility("chat", false, true)).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })
})
