import { describe, it, expect } from "bun:test"
import { routeIssue } from "../src/routing.js"

describe("routeIssue", () => {
  describe("coding-implementer states", () => {
    const ciStates = ["Prepare", "Test", "Merge", "Closure", "Rebase", "PR Triage"]

    for (const state of ciStates) {
      it(`routes '${state}' → coding-implementer`, () => {
        expect(routeIssue(state)).toBe("coding-implementer")
      })
    }
  })

  describe("code-review states", () => {
    const crStates = ["Review", "Request Changes"]

    for (const state of crStates) {
      it(`routes '${state}' → code-review`, () => {
        expect(routeIssue(state)).toBe("code-review")
      })
    }
  })

  describe("unroutable states", () => {
    const skipped = ["Backlog", "Waiting", "Done", "Cancelled", "Duplicate", "In Progress", "", "unknown-state"]

    for (const state of skipped) {
      it(`returns null for '${state}'`, () => {
        expect(routeIssue(state)).toBeNull()
      })
    }
  })
})
