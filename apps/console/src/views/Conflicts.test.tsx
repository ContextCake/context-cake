// @vitest-environment jsdom
// Professional discrepancy presentation and governed decision affordances.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conflicts } from './Conflicts'
import { previewSentence } from './conflicts/BulkBar'
import { actionLabel, matchLabel } from './conflicts/Rules'
import type { Conflict } from '../data'
import type { DiscrepancyBatchRequest, DiscrepancyBatchResponse } from '../types'

const mocks = vi.hoisted(() => ({
  useStore: vi.fn(),
}))

vi.mock('../store', () => ({ useStore: mocks.useStore, useStoreData: mocks.useStore, useStoreNav: mocks.useStore, useStoreInput: mocks.useStore, useStoreChat: mocks.useStore }))

let container: HTMLDivElement
let root: Root

function storeWith(conflicts: Conflict[], selConflict: string) {
  return {
    mode: 'demo', query: '', setQuery: vi.fn(),
    conflicts,
    selConflict,
    setSelConflict: vi.fn(),
    resolveConflict: vi.fn(),
    resolveSafeConflicts: vi.fn(),
    resolvingConflict: null,
    resolutionError: null as { message: string; partial: boolean } | null,
    discrepancyRules: [], discrepancyRuleSuggestions: [],
    decideDiscrepancy: vi.fn(), setDiscrepancyPriority: vi.fn(),
    // The batch answers "every item went through" unless a test says otherwise.
    decideDiscrepancies: vi.fn(async (request: DiscrepancyBatchRequest): Promise<DiscrepancyBatchResponse> => ({
      ok: true, applied: request.dryRun ? 0 : request.decisions.length, failed: 0,
      results: request.decisions.map((decision) => ({ discrepancyId: decision.discrepancyId, ok: true, ...(request.dryRun ? { wouldWrite: [] } : {}) })),
      suggestions: [],
    })),
    loadDiscrepancyDetail: vi.fn(),
    sources: [{ name: 'personal', sourceKind: 'okf-local' }, { name: 'team', sourceKind: 'files' }, { name: 'company', sourceKind: 'mcp' }],
    approveRuleSuggestion: vi.fn(), updateDiscrepancyRule: vi.fn(), promoteDiscrepancyRule: vi.fn(),
    openFilesScope: vi.fn(), openConcept: vi.fn(),
  }
}

const freshConflict: Conflict = {
  id: 'decisions/primary-db::choice',
  concept: 'decisions/primary-db',
  sectionKey: 'choice',
  section: 'Choice',
  title: 'Choice — Primary database',
  status: 'open',
  winner: 'personal',
  safe: false,
  history: [],
  kind: 'section_content', discrepancyStatus: 'needs_review', revision: 'rev-1',
  effectiveSource: 'personal', winnerReason: 'personal wins by configured layer precedence.',
  owner: 'Platform', priority: 'unassigned', coverageComplete: true,
  sourceHealth: [{ source: 'personal', status: 'ok', error: null }, { source: 'team', status: 'ok', error: null }],
  contributions: [
    { layer: 'personal', sourceLayer: 'personal', value: 'SingleStore.', updated: '2026-05-12' },
    { layer: 'team', sourceLayer: 'team', value: 'Postgres.', updated: '2026-06-01', fresherDissent: true },
  ],
}

const staleConflict: Conflict = {
  ...freshConflict,
  id: 'decisions/primary-db::notes',
  sectionKey: 'notes',
  section: 'Notes',
  title: 'Notes — Primary database',
  contributions: [
    { layer: 'personal', sourceLayer: 'personal', value: 'HTAP first.', updated: '2026-06-01' },
    { layer: 'team', sourceLayer: 'team', value: 'Cost first.', updated: '2026-05-12' },
  ],
}

const safeConflict: Conflict = {
  ...staleConflict,
  id: 'interfaces/auth-tokens::header',
  concept: 'interfaces/auth-tokens',
  sectionKey: 'header',
  section: 'Header',
  title: 'Header — Auth tokens',
  safe: true,
  contributions: [
    { layer: 'team', sourceLayer: 'team', value: 'Send the token as bearer.', updated: '2026-06-01' },
    { layer: 'company', sourceLayer: 'company', value: 'Send the token as **Bearer**', updated: '2026-05-12' },
  ],
}

const codeConflict: Conflict = {
  ...freshConflict,
  id: 'interfaces/client::example',
  concept: 'interfaces/client',
  sectionKey: 'example',
  section: 'Example',
  contributions: [
    { layer: 'personal', sourceLayer: 'personal', value: 'const port = 3000;\nstart(port);', updated: '2026-05-12' },
    { layer: 'team', sourceLayer: 'team', value: 'const port = 8080;\nstart(port);', updated: '2026-06-01' },
  ],
}

const listConflict: Conflict = {
  ...freshConflict,
  id: 'decisions/primary-db::tags',
  sectionKey: 'tags',
  section: 'Tags',
  title: 'Tags — Primary database',
  kind: 'frontmatter_value',
  isList: true,
  contributions: [
    { layer: 'personal', sourceLayer: 'personal', value: '["postgres","oltp"]', updated: '2026-05-12' },
    { layer: 'team', sourceLayer: 'team', value: '["mysql"]', updated: '2026-06-01' },
  ],
}

const brokenLinkConflict: Conflict = {
  ...freshConflict,
  id: 'decisions/primary-db::choice::missing-target',
  kind: 'broken_link',
  target: 'decisions/missing',
  contributions: [
    { layer: 'personal', sourceLayer: 'personal', value: 'decisions/missing', updated: '2026-05-12' },
  ],
}

const companyContributorConflict: Conflict = {
  ...freshConflict,
  id: 'other/concept::field',
  concept: 'other/concept',
  sectionKey: 'field',
  section: 'Field',
  title: 'Field — Other concept',
  contributions: [
    { layer: 'company', sourceLayer: 'company', value: 'Company answer.', updated: '2026-05-12' },
  ],
}

const resolvedViaEffectiveSource: Conflict = {
  ...freshConflict,
  id: 'decisions/primary-db::resolved-effective',
  sectionKey: 'resolved-effective',
  section: 'Resolved effective',
  title: 'Resolved effective — Primary database',
  status: 'resolved',
  discrepancyStatus: 'resolved',
  effectiveSource: 'company',
  // Deliberately no 'company' contribution in the snapshot — the filter must
  // still match on effectiveSource, not only the contributions array (F13).
  contributions: [
    { layer: 'team', sourceLayer: 'team', value: 'Postgres.', updated: '2026-01-01' },
  ],
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('Discrepancy Center', () => {
  it('explains the review workflow before presenting filters and evidence', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))

    const guide = container.querySelector('[aria-label="How to resolve a discrepancy"]')
    expect(guide?.textContent).toContain('Review the evidence')
    expect(guide?.textContent).toContain('Choose the safest next step')
    expect(guide?.textContent).toContain('Confirm what changes')
    // Tabs carry a count now ("Needs review 1"), so match on the label prefix.
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('.cc-status-tabs button')).find((button) => button.textContent?.startsWith('Needs review'))?.getAttribute('aria-pressed')).toBe('true')
  })

  it('badges the flagged dissent card as newer than the effective value', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict, staleConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).toContain('Newer dissent')
    expect(container.textContent).toContain('Effective now')
    expect(container.textContent).toContain('Choose a safe disposition')
  })

  it('shows no freshness badge when no dissent is flagged', async () => {
    mocks.useStore.mockReturnValue(storeWith([staleConflict], staleConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(Array.from(container.querySelectorAll('.cc-discrepancy-answer')).some((answer) => answer.textContent?.includes('Newer dissent'))).toBe(false)
  })

  it('shows both removed and added prose instead of hiding reordered or deleted words', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.querySelector('.cc-word-diff del')?.textContent).toContain('SingleStore')
    expect(container.querySelector('.cc-word-diff mark')?.textContent).toContain('Postgres')
  })

  it('shows removed and added lines for structured content', async () => {
    mocks.useStore.mockReturnValue(storeWith([codeConflict], codeConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.querySelector('.cc-line-diff [data-change="removed"]')?.textContent).toContain('3000')
    expect(container.querySelector('.cc-line-diff [data-change="added"]')?.textContent).toContain('8080')
    expect(container.querySelector('.cc-line-diff [data-change="removed"]')?.textContent).toContain('Removed:')
    expect(container.querySelector('.cc-line-diff [data-change="added"]')?.textContent).toContain('Added:')
  })

  it('labels every demo action as a simulation and never offers automatic execution', async () => {
    const store = storeWith([safeConflict], safeConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).toContain('Simulate using')
    expect(container.textContent).toContain('Simulation history resets on reload.')
  })

  it('requires a reason before an acknowledgement can be submitted', async () => {
    const store = storeWith([safeConflict], safeConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))
    const radio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Keep the scoped difference'))!
    await act(async () => radio.click())
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Simulate acknowledgement'))!
    expect(submit.disabled).toBe(true)
    const reason = container.querySelector<HTMLSelectElement>('[aria-label="Acknowledgement reason"]')!
    await act(async () => { reason.value = 'different_scopes'; reason.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(submit.disabled).toBe(false)
  })

  it('gives every disposition radio the same name so they behave as one group', async () => {
    mocks.useStore.mockReturnValue(storeWith([safeConflict], safeConflict.id))
    await act(async () => root.render(<Conflicts />))
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    expect(radios.length).toBeGreaterThan(1)
    expect(new Set(radios.map((input) => input.name)).size).toBe(1)
    expect(radios[0].name).not.toBe('')
  })

  // F22a: does ArrowDown move focus/selection between the disposition radios?
  //
  // jsdom cannot answer this directly — same-name radio-group arrow
  // navigation is a browser default action implemented well below the DOM
  // event layer (Blink's RadioInputType::handleKeydownEvent), not something
  // triggered by dispatching a keydown event, trusted or not. A jsdom probe
  // (`input.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown'}))`
  // on a bare same-name radio pair, no framework involved) confirmed jsdom
  // does not implement it — focus and `checked` were unchanged after the
  // dispatch, so a "does ArrowDown move focus" assertion here would only
  // test jsdom's fidelity, not this component.
  //
  // Manually verified instead, in a real Chromium tab (CDP-level keyboard
  // input, not a synthetic DOM event) against the running app: focusing the
  // first `cc-disposition` radio and pressing the real ArrowDown key moved
  // both focus and `checked` to the second radio. No extra keydown handling
  // was added — native same-name-radio-group behavior already covers this,
  // which is exactly what the structural preconditions below exist to keep
  // true: same `name`, no `<form>` boundary between them (an explicit form
  // owner would scope the group to elements sharing THAT owner), and no
  // radio hidden in a way (`display:none`, `disabled`) that would pull it out
  // of the group's focus order.
  it('keeps the disposition radios in one native focus-navigable group (no form owner, none display:none or disabled)', async () => {
    mocks.useStore.mockReturnValue(storeWith([safeConflict], safeConflict.id))
    await act(async () => root.render(<Conflicts />))
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="cc-disposition"]'))
    expect(radios.length).toBeGreaterThan(1)
    for (const radio of radios) {
      expect(radio.form).toBeNull()
      expect(radio.disabled).toBe(false)
      expect(getComputedStyle(radio).display).not.toBe('none')
    }
  })

  it('starts the compose field empty and submits exactly what was typed, never the old value plus new text', async () => {
    const store = storeWith([freshConflict], freshConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    const composeRadio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Write a reconciled answer'))!
    await act(async () => composeRadio.click())

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reconciled Markdown"]')!
    expect(textarea.value).toBe('')
    expect(textarea.placeholder).toContain('Write the reconciled answer')

    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Simulate reconciled answer'))!
    expect(submit.disabled).toBe(true)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Only the freshly typed reconciliation.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submit.disabled).toBe(false)

    await act(async () => submit.click())
    expect(store.decideDiscrepancy).toHaveBeenCalledWith(expect.objectContaining({ content: 'Only the freshly typed reconciliation.' }))
  })

  it('resets the compose field to empty when the selected conflict changes', async () => {
    // Conflicts is a props-less memo (see the note at the bottom of this
    // file's subject) and the store hooks are mocked as plain functions, not
    // reactive context — so a second root.render() with the same (empty)
    // props bails out via memo and never re-invokes the component. Force a
    // genuine remount, the same way a real navigation to a different
    // discrepancy would, to exercise the conflict.id-keyed reset effect.
    mocks.useStore.mockReturnValue(storeWith([freshConflict, staleConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))
    const composeRadio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Write a reconciled answer'))!
    await act(async () => composeRadio.click())
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reconciled Markdown"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Draft for the first conflict.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(textarea.value).toBe('Draft for the first conflict.')

    await act(async () => root.unmount())
    root = createRoot(container)
    mocks.useStore.mockReturnValue(storeWith([freshConflict, staleConflict], staleConflict.id))
    await act(async () => root.render(<Conflicts />))
    const composeRadioAfter = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Write a reconciled answer'))!
    await act(async () => composeRadioAfter.click())
    const textareaAfter = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reconciled Markdown"]')!
    expect(textareaAfter.value).toBe('')
  })

  it('offers to start the compose field from the winning contributor without prefilling it automatically', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))
    const composeRadio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Write a reconciled answer'))!
    await act(async () => composeRadio.click())

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reconciled Markdown"]')!
    expect(textarea.value).toBe('')
    const startButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.startsWith('Start from'))!
    expect(startButton).toBeTruthy()

    await act(async () => startButton.click())
    expect(textarea.value).toBe('SingleStore.')
  })

  it('disables compose for an array-typed frontmatter discrepancy and explains why', async () => {
    mocks.useStore.mockReturnValue(storeWith([listConflict], listConflict.id))
    await act(async () => root.render(<Conflicts />))

    const composeRadio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Write a reconciled answer'))!
    expect(composeRadio.disabled).toBe(true)
    expect(container.textContent).toContain('This field is a list — pick an existing answer or edit the file directly.')
  })

  it('labels a frontmatter compose field "Reconciled value" and hides the Markdown preview affordance', async () => {
    const listConflictComposable: Conflict = { ...listConflict, isList: false }
    mocks.useStore.mockReturnValue(storeWith([listConflictComposable], listConflictComposable.id))
    await act(async () => root.render(<Conflicts />))

    const composeRadio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Write a reconciled answer'))!
    await act(async () => composeRadio.click())

    expect(container.querySelector('[aria-label="Reconciled value"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Reconciled Markdown"]')).toBeFalsy()
    expect(container.textContent).not.toContain('Preview Markdown')
  })

  it('turns a broken link into a clear one-click recommendation instead of selecting an impossible winner action', async () => {
    const store = storeWith([brokenLinkConflict], brokenLinkConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).toContain('Keep the link for now')
    expect(container.textContent).toContain('No files change; this moves the item to Acknowledged.')
    expect(container.textContent).not.toContain('Use personal everywhere')
    expect(container.textContent).not.toContain('Choose a safe disposition')
    expect(container.textContent).not.toContain('Leave open')
    expect(container.querySelector<HTMLDetailsElement>('.cc-review-details')?.open).toBe(false)
    expect(container.querySelector<HTMLDetailsElement>('.cc-more-options')?.open).toBe(false)

    const recommended = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Simulate acknowledging')!
    await act(async () => recommended.click())
    expect(store.decideDiscrepancy).toHaveBeenCalledWith({
      discrepancyId: brokenLinkConflict.id,
      revision: brokenLinkConflict.revision,
      action: 'acknowledge',
      reasonCode: 'target_missing',
      note: '',
    })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Acknowledged “decisions/missing” as Target not created yet. No files changed.')
    expect(container.textContent).toContain('View in Acknowledged')
  })

  it('keeps a broken-link decision failure in the panel for retry instead of leaking a rejected promise', async () => {
    const store = storeWith([brokenLinkConflict], brokenLinkConflict.id)
    store.decideDiscrepancy = vi.fn().mockRejectedValue(new Error('Revision changed'))
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    const recommended = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Simulate acknowledging')!
    await act(async () => recommended.click())
    expect(store.decideDiscrepancy).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('View in Acknowledged')
  })

  it('does not carry a previous discrepancy error into an item the user has not attempted', async () => {
    const store = storeWith([brokenLinkConflict], brokenLinkConflict.id)
    store.resolutionError = { message: 'A different item failed', partial: false }
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).not.toContain('A different item failed')
  })

  it('routes a broken link directly to its source concept for an immediate edit', async () => {
    const store = storeWith([brokenLinkConflict], brokenLinkConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    const openSource = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Open source concept')!
    await act(async () => openSource.click())
    expect(store.openConcept).toHaveBeenCalledWith(brokenLinkConflict.concept)
  })

  it('keeps alternative acknowledgement reasons available for a broken link', async () => {
    mocks.useStore.mockReturnValue(storeWith([brokenLinkConflict], brokenLinkConflict.id))
    await act(async () => root.render(<Conflicts />))
    const options = Array.from(container.querySelectorAll<HTMLOptionElement>('[aria-label="Acknowledgement reason"] option')).map((option) => option.textContent)
    expect(options).toContain('Target not created yet')
    const moreOptions = container.querySelector<HTMLDetailsElement>('.cc-more-options')!
    await act(async () => {
      moreOptions.open = true
      moreOptions.dispatchEvent(new Event('toggle'))
    })
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Acknowledgement reason"]')?.value).toBe('')
  })

  it('never offers "Target not created yet" for a non-broken-link discrepancy', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))
    const otherRadio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Keep the scoped difference'))!
    await act(async () => otherRadio.click())
    const otherOptions = Array.from(container.querySelectorAll<HTMLOptionElement>('[aria-label="Acknowledgement reason"] option')).map((option) => option.textContent)
    expect(otherOptions).not.toContain('Target not created yet')
  })

  it('names the active search in the empty state and clears it on request', async () => {
    const store = storeWith([freshConflict], freshConflict.id)
    store.query = 'nothing will match this'
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).toContain('No matches for "nothing will match this" in this status.')
    const clear = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Clear search')!
    await act(async () => clear.click())
    expect(store.setQuery).toHaveBeenCalledWith('')
  })

  it('still shows the generic empty state when no search is active', async () => {
    mocks.useStore.mockReturnValue(storeWith([], ''))
    await act(async () => root.render(<Conflicts />))
    expect(container.textContent).toContain('No discrepancies in this view')
    expect(container.textContent).not.toContain('No matches for')
  })

  it('matches a resolved discrepancy on effectiveSource even when its contribution snapshot lacks that source (F13)', async () => {
    mocks.useStore.mockReturnValue(storeWith([companyContributorConflict, resolvedViaEffectiveSource], resolvedViaEffectiveSource.id))
    await act(async () => root.render(<Conflicts />))

    const resolvedTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.cc-status-tabs button')).find((button) => button.textContent?.startsWith('Resolved'))!
    await act(async () => resolvedTab.click())
    expect(container.textContent).toContain('Resolved effective')

    const sourceSelect = container.querySelector<HTMLSelectElement>('[aria-label="Source"]')!
    await act(async () => { sourceSelect.value = 'company'; sourceSelect.dispatchEvent(new Event('change', { bubbles: true })) })

    expect(container.textContent).toContain('Resolved effective')
  })
})

// ---- The redesign: overview tiles, grouping, selection, bulk actions, fixes ----

const $$ = <T extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<T>(selector))
const buttons = () => $$<HTMLButtonElement>('button')
const itemRows = () => $$<HTMLElement>('.cc-conflict-list [role="option"][data-row="item"]')
const groupRows = () => $$<HTMLElement>('.cc-conflict-list [role="option"][data-row="group"]')
const press = (node: Element, key: string, init: KeyboardEventInit = {}) =>
  node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
const click = (node: Element, init: MouseEventInit = {}) =>
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
const active = () => document.activeElement as HTMLElement | null

const brokenTo = (id: string, target: string, best: string | null, extra: Partial<Conflict> = {}): Conflict => ({
  ...brokenLinkConflict,
  id: `broken_link::${id}`,
  concept: `notes/${id}`,
  conceptTitle: `Note ${id}`,
  target,
  contributions: [{ layer: 'personal', sourceLayer: 'personal', value: target, updated: '2026-05-12' }],
  candidates: best ? [{ id: best, reason: 'case', confidence: 0.95 }, { id: `${best}-alt`, reason: 'typo', confidence: 0.55 }] : [],
  bestCandidate: best ? { id: best, reason: 'case', confidence: 0.95 } : null,
  ...extra,
})

describe('Discrepancy Center — overview and grouping', () => {
  it('shows counts on the tiles and the tabs, and a tile click applies its filter', async () => {
    const rows = [freshConflict, staleConflict, brokenTo('l1', 'decisions/Old', 'decisions/old'), brokenTo('l2', 'decisions/Old', 'decisions/old')]
    mocks.useStore.mockReturnValue(storeWith(rows, freshConflict.id))
    await act(async () => root.render(<Conflicts />))

    const tiles = $$<HTMLButtonElement>('.cc-dc-tile')
    expect(tiles[0].textContent).toContain('4')
    expect(tiles[0].textContent).toContain('actionable')
    const brokenTile = tiles.find((tile) => tile.textContent?.includes('broken links'))!
    expect(brokenTile.textContent).toContain('2')
    expect($$('.cc-status-tabs button').map((tab) => tab.textContent)).toEqual(['Needs review4', 'Recommendations0', 'Automated0', 'Acknowledged0', 'Resolved0'])
    // "2 of 2 broken links have a suggested fix" — the quick win reads off the summary.
    expect(container.querySelector('.cc-dc-quick')?.textContent).toContain('2 of 2 broken links have a suggested fix')

    await act(async () => brokenTile.click())
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Kind"]')?.value).toBe('broken_link')
    expect(itemRows()).toHaveLength(2)
    expect(brokenTile.getAttribute('aria-pressed')).toBe('true')

    // The quick-win tile narrows further to links with a fix; the checkbox that appears clears it.
    const quick = $$<HTMLButtonElement>('.cc-dc-quick button').find((button) => button.textContent?.includes('suggested fix'))!
    await act(async () => quick.click())
    expect(itemRows()).toHaveLength(2)
    expect(container.textContent).toContain('Has a suggested fix')
  })

  it('groups by kind with broken links sub-grouped by target, collapsed by default past three groups', async () => {
    const rows = [
      freshConflict, listConflict,
      brokenTo('l1', 'decisions/Old', 'decisions/old'), brokenTo('l2', 'decisions/Old', 'decisions/old'),
      brokenTo('l3', 'decisions/gone', null),
      { ...freshConflict, id: 'changed', kind: 'changed_after_decision' as const },
    ]
    mocks.useStore.mockReturnValue(storeWith(rows, freshConflict.id))
    await act(async () => root.render(<Conflicts />))

    // Five groups → all closed; only headers render, largest first.
    expect(groupRows().map((row) => row.getAttribute('aria-label'))).toEqual([
      'Broken link → decisions/Old, 2 items, 2 actionable, collapsed',
      'Broken link → decisions/gone, 1 item, 1 actionable, collapsed',
      'Changed after decision, 1 item, 1 actionable, collapsed',
      'Frontmatter value, 1 item, 1 actionable, collapsed',
      'Section content, 1 item, 1 actionable, collapsed',
    ])
    expect(itemRows()).toHaveLength(0)
    expect(groupRows()[0].textContent).toContain('fix → decisions/old')

    await act(async () => click(groupRows()[0]))
    expect(itemRows()).toHaveLength(2)
    expect(groupRows()[0].getAttribute('aria-label')).toContain('expanded')

    // Switching the grouping resets the collapse state.
    const concept = $$<HTMLButtonElement>('.cc-ui-segmented button').find((button) => button.textContent === 'Concept')!
    await act(async () => concept.click())
    expect(groupRows().length).toBeGreaterThan(3)
    expect(itemRows()).toHaveLength(0)
  })

  it('opens every group when there are three or fewer', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict, staleConflict, listConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))
    expect(groupRows()).toHaveLength(2)
    expect(itemRows()).toHaveLength(3)
  })
})

describe('Discrepancy Center — selection and bulk actions', () => {
  it('Shift+click selects the range between the anchor and the clicked row, and the group checkbox takes the whole group', async () => {
    const rows = [freshConflict, staleConflict, codeConflict, listConflict]
    const store = storeWith(rows, freshConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))
    // Two groups (section content ×3, frontmatter ×1), both open.
    const items = itemRows()
    expect(items).toHaveLength(4)

    await act(async () => click(items[0].querySelector('.cc-row-check')!))
    expect(items[0].getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('.cc-bulk-bar')?.textContent).toContain('1 selected')

    await act(async () => click(items[2].querySelector('.cc-row-check')!, { shiftKey: true }))
    expect(itemRows().filter((row) => row.getAttribute('aria-selected') === 'true')).toHaveLength(3)
    expect(container.querySelector('.cc-bulk-bar')?.textContent).toContain('3 selected')
    // The group header of a fully selected group reads selected; a partial one does not.
    expect(groupRows()[0].getAttribute('aria-selected')).toBe('true')

    // Clicking a group's checkbox again clears that group.
    await act(async () => click(groupRows()[0].querySelector('.cc-row-check')!))
    expect(itemRows().filter((row) => row.getAttribute('aria-selected') === 'true')).toHaveLength(0)
    expect(container.querySelector('.cc-bulk-bar')).toBeNull()

    // And Space on the focused row toggles it without opening the detail.
    await act(async () => { itemRows()[1].focus(); press(itemRows()[1], ' ') })
    expect(itemRows()[1].getAttribute('aria-selected')).toBe('true')
    expect(store.setSelConflict).not.toHaveBeenCalledWith(staleConflict.id)
  })

  it('offers rewrite/create only when every selected row is a broken link to one target, unlink for any broken links, and "use source" only for non-links', async () => {
    const rows = [
      brokenTo('l1', 'decisions/Old', 'decisions/old'), brokenTo('l2', 'decisions/Old', 'decisions/old'),
      brokenTo('l3', 'decisions/gone', null),
      freshConflict, staleConflict,
    ]
    mocks.useStore.mockReturnValue(storeWith(rows, freshConflict.id))
    await act(async () => root.render(<Conflicts />))
    // Three groups → open. Order: Old(2), Section content(2), gone(1).
    const oldGroup = groupRows().find((row) => row.getAttribute('aria-label')?.startsWith('Broken link → decisions/Old'))!
    await act(async () => click(oldGroup.querySelector('.cc-row-check')!))
    let bar = container.querySelector('.cc-bulk-bar')!
    expect(bar.textContent).toContain('Rewrite 2 links')
    expect(bar.textContent).toContain('Remove 2 links')
    expect(bar.textContent).toContain('Create')
    expect(bar.querySelector<HTMLSelectElement>('[aria-label="Rewrite links to"]')?.value).toBe('decisions/old')
    expect(bar.querySelector<HTMLSelectElement>('[aria-label="Layer to create the concept in"]')?.value).toBe('personal')
    // A writable layer only: the MCP source is not offered.
    expect(Array.from(bar.querySelectorAll('[aria-label="Layer to create the concept in"] option')).map((option) => option.textContent)).toEqual(['personal', 'team'])
    expect(bar.textContent).not.toContain('Use')

    // Add a link to another target: rewrite and create go, remove stays.
    const goneGroup = groupRows().find((row) => row.getAttribute('aria-label')?.startsWith('Broken link → decisions/gone'))!
    await act(async () => click(goneGroup.querySelector('.cc-row-check')!))
    bar = container.querySelector('.cc-bulk-bar')!
    expect(bar.textContent).toContain('3 selected')
    expect(bar.textContent).not.toContain('Rewrite')
    expect(bar.textContent).not.toContain('Create')
    expect(bar.textContent).toContain('Remove 3 links')

    // Add a section conflict: only acknowledge remains.
    const sectionGroup = groupRows().find((row) => row.getAttribute('aria-label')?.startsWith('Section content'))!
    await act(async () => click(sectionGroup.querySelector('.cc-row-check')!))
    bar = container.querySelector('.cc-bulk-bar')!
    expect(bar.textContent).toContain('5 selected')
    expect(bar.textContent).not.toContain('Remove')
    expect(bar.textContent).toContain('Acknowledge 5…')

    // Only the section conflicts: "Use <source> for N" over their shared sources.
    await act(async () => click(oldGroup.querySelector('.cc-row-check')!))
    await act(async () => click(goneGroup.querySelector('.cc-row-check')!))
    bar = container.querySelector('.cc-bulk-bar')!
    expect(bar.textContent).toContain('2 selected')
    expect(Array.from(bar.querySelectorAll('[aria-label="Source to use everywhere"] option')).map((option) => option.textContent)).toEqual(['personal', 'team'])
  })

  it('previews every bulk action with a dry run before applying it, and sends newTarget for a rewrite', async () => {
    const rows = [brokenTo('l1', 'decisions/Old', 'decisions/old'), brokenTo('l2', 'decisions/Old', 'decisions/old')]
    const store = storeWith(rows, rows[0].id)
    store.decideDiscrepancies = vi.fn(async (request: DiscrepancyBatchRequest): Promise<DiscrepancyBatchResponse> => ({
      ok: true, applied: request.dryRun ? 0 : 2, failed: 0,
      results: request.decisions.map((decision, index) => ({
        discrepancyId: decision.discrepancyId, ok: true,
        ...(request.dryRun ? { wouldWrite: [{ layer: index === 0 ? 'personal' : 'team', path: `notes/${index}.md` }] } : {}),
      })),
      suggestions: [],
    }))
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    await act(async () => click(groupRows()[0].querySelector('.cc-row-check')!))
    const rewrite = buttons().find((button) => button.textContent?.startsWith('Rewrite 2 links'))!
    await act(async () => rewrite.click())

    expect(store.decideDiscrepancies).toHaveBeenCalledTimes(1)
    expect(store.decideDiscrepancies.mock.calls[0][0]).toMatchObject({
      dryRun: true,
      decisions: [
        { discrepancyId: rows[0].id, revision: 'rev-1', action: 'rewrite_link', newTarget: 'decisions/old' },
        { discrepancyId: rows[1].id, revision: 'rev-1', action: 'rewrite_link', newTarget: 'decisions/old' },
      ],
    })
    // Demo mode says so honestly; the live sentence is pinned by the previewSentence tests below.
    const confirm = container.querySelector('.cc-bulk-confirm')!
    expect(confirm.textContent).toContain('Rewrite 2 links to decisions/old.')
    expect(confirm.textContent).toContain('Simulation — nothing changes on disk; 2 decisions will be recorded until reload.')

    const apply = buttons().find((button) => button.textContent === 'Simulate for 2')!
    await act(async () => apply.click())
    expect(store.decideDiscrepancies).toHaveBeenCalledTimes(2)
    expect(store.decideDiscrepancies.mock.calls[1][0].dryRun).toBeUndefined()
    expect(store.decideDiscrepancies.mock.calls[1][0].decisions).toHaveLength(2)
    expect(container.querySelector('[role="status"].cc-decision-receipt')?.textContent).toContain('2 done.')
    expect(container.querySelector('.cc-bulk-bar')).toBeNull()
  })

  it('reports a partial failure as "N done · M need attention" and keeps only the failures selected', async () => {
    const rows = [freshConflict, staleConflict, codeConflict]
    const store = storeWith(rows, freshConflict.id)
    store.decideDiscrepancies = vi.fn(async (request: DiscrepancyBatchRequest): Promise<DiscrepancyBatchResponse> => ({
      ok: false, applied: request.dryRun ? 0 : 2, failed: request.dryRun ? 0 : 1,
      results: request.decisions.map((decision) => (request.dryRun || decision.discrepancyId !== staleConflict.id
        ? { discrepancyId: decision.discrepancyId, ok: true }
        : { discrepancyId: decision.discrepancyId, ok: false, status: 409, code: 'STALE', error: 'The record changed since you loaded it.' })),
      suggestions: [],
    }))
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    await act(async () => click(groupRows()[0].querySelector('.cc-row-check')!))
    expect(container.querySelector('.cc-bulk-bar')?.textContent).toContain('3 selected')
    await act(async () => buttons().find((button) => button.textContent === 'Acknowledge 3…')!.click())
    const reason = container.querySelector<HTMLSelectElement>('.cc-bulk-ack [aria-label="Acknowledgement reason"]')!
    await act(async () => { reason.value = 'different_scopes'; reason.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => buttons().find((button) => button.textContent === 'Preview')!.click())
    expect(container.querySelector('.cc-bulk-confirm')?.textContent).toContain('Acknowledge 3 items.')
    await act(async () => buttons().find((button) => button.textContent === 'Simulate for 3')!.click())

    expect(store.decideDiscrepancies.mock.calls[1][0].decisions.every((decision: { action: string; reasonCode?: string }) => decision.action === 'acknowledge' && decision.reasonCode === 'different_scopes')).toBe(true)
    const receipt = container.querySelector('[role="status"].cc-decision-receipt')!
    expect(receipt.textContent).toContain('2 done · 1 need attention.')
    expect(receipt.textContent).toContain('stay selected')
    const selected = itemRows().filter((row) => row.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toContain('Notes')
    expect(container.querySelector('.cc-bulk-bar')?.textContent).toContain('1 selected')
  })
})

describe('Discrepancy Center — broken-link fixes and detail loading', () => {
  it('leads with the suggested fix and sends rewrite_link with newTarget; the other candidates, remove and create follow', async () => {
    const link = brokenTo('l1', 'decisions/Old', 'decisions/old')
    const store = storeWith([link], link.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    expect(container.querySelector('.cc-recommendation-label')?.textContent).toBe('Suggested fix')
    expect(container.querySelector('.cc-smart-resolution h3')?.textContent).toBe('Rewrite to decisions/old')
    expect(container.querySelector('.cc-smart-resolution p')?.textContent).toContain('differs only by case')
    // The old recommendation is demoted to the list of other ways, not gone.
    expect(container.querySelector('.cc-smart-resolution')?.textContent).not.toContain('Keep the link for now')
    expect(container.querySelector('.cc-link-fixes')?.textContent).toContain('Keep the link for now')

    const other = container.querySelector('.cc-link-candidates')!
    expect(other.textContent).toContain('decisions/old-alt')
    expect(other.textContent).toContain('one or two characters off')
    expect(container.textContent).toContain('Remove the link')
    expect(container.textContent).toContain('Create decisions/Old')
    expect(container.querySelector<HTMLSelectElement>('.cc-link-fixes [aria-label="Layer to create the concept in"]')?.value).toBe('personal')

    await act(async () => buttons().find((button) => button.textContent === 'Simulate rewrite')!.click())
    expect(store.decideDiscrepancy).toHaveBeenCalledWith({ discrepancyId: link.id, revision: 'rev-1', action: 'rewrite_link', newTarget: 'decisions/old' })
    expect(container.querySelector('[role="status"].cc-decision-receipt')?.textContent).toContain('Rewrote the link to “decisions/old” in personal.')
  })

  it('sends unlink and create_stub (with the chosen layer) from the panel', async () => {
    const link = brokenTo('l1', 'decisions/Old', null)
    const store = storeWith([link], link.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))
    // No confident candidate: the original recommendation leads, the fixes are below it.
    expect(container.textContent).toContain('Keep the link for now')
    expect(container.querySelector('.cc-link-fixes > strong')?.textContent).toBe('Fix it now')

    await act(async () => buttons().find((button) => button.textContent === 'Simulate removal')!.click())
    expect(store.decideDiscrepancy).toHaveBeenLastCalledWith({ discrepancyId: link.id, revision: 'rev-1', action: 'unlink' })

    const layer = container.querySelector<HTMLSelectElement>('.cc-link-fixes [aria-label="Layer to create the concept in"]')!
    await act(async () => { layer.value = 'team'; layer.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => buttons().find((button) => button.textContent === 'Simulate creating')!.click())
    expect(store.decideDiscrepancy).toHaveBeenLastCalledWith({ discrepancyId: link.id, revision: 'rev-1', action: 'create_stub', layer: 'team' })
  })

  it('shows a skeleton instead of a decision panel or answers until the full record has loaded, and asks for it', async () => {
    const compact: Conflict = { ...freshConflict, detailLoaded: false, historyCount: 2, contributions: freshConflict.contributions.map((entry) => ({ ...entry, truncated: true })) }
    const store = storeWith([compact], compact.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    expect(store.loadDiscrepancyDetail).toHaveBeenCalledWith(compact.id)
    expect(container.querySelectorAll('.cc-skeleton').length).toBeGreaterThanOrEqual(2)
    expect(container.textContent).not.toContain('Choose a safe disposition')
    expect(container.querySelector('.cc-word-diff')).toBeNull()
    expect(container.textContent).toContain('Loading 2 decisions')
    // The row itself renders from the compact record — nothing waits on the detail.
    expect(itemRows()).toHaveLength(1)
  })
})

describe('Discrepancy Center — keyboard and windowing', () => {
  it('walks across a group boundary with the arrows, opens and closes groups with Right/Left, and Enter opens a row', async () => {
    const rows = [
      brokenTo('l1', 'decisions/Old', 'decisions/old'), brokenTo('l2', 'decisions/Old', 'decisions/old'),
      brokenTo('l3', 'decisions/gone', null),
      freshConflict, listConflict,
    ]
    const store = storeWith(rows, freshConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))
    // Four groups → closed. One tab stop, on the header of the first group.
    const stops = $$('.cc-conflict-list [role="option"][tabindex="0"]')
    expect(stops).toHaveLength(1)
    await act(async () => stops[0].focus())
    expect(active()?.getAttribute('data-row')).toBe('group')

    await act(async () => press(active()!, 'ArrowRight')) // opens
    expect(active()?.getAttribute('aria-label')).toContain('expanded')
    await act(async () => press(active()!, 'ArrowRight')) // into the first child
    expect(active()?.getAttribute('data-row')).toBe('item')
    await act(async () => press(active()!, 'ArrowDown'))
    await act(async () => press(active()!, 'ArrowDown')) // past the last item of the group → next header
    expect(active()?.getAttribute('data-row')).toBe('group')
    expect(active()?.getAttribute('aria-label')).toContain('decisions/gone')
    await act(async () => press(active()!, 'ArrowUp'))
    expect(active()?.getAttribute('data-row')).toBe('item')
    await act(async () => press(active()!, 'ArrowLeft')) // back to its group header
    expect(active()?.getAttribute('aria-label')).toContain('decisions/Old')
    await act(async () => press(active()!, 'ArrowLeft')) // closes it
    expect(active()?.getAttribute('aria-label')).toContain('collapsed')
    await act(async () => press(active()!, 'End'))
    expect(active()?.getAttribute('aria-label')).toContain('Section content')
    await act(async () => press(active()!, 'ArrowRight'))
    await act(async () => press(active()!, 'ArrowRight'))
    await act(async () => press(active()!, 'Enter'))
    expect(store.setSelConflict).toHaveBeenCalledWith(freshConflict.id)
    expect($$('.cc-conflict-list [role="option"][tabindex="0"]')).toHaveLength(1)
  })

  it('renders only a window of a long list, and keeps the focused row mounted when it walks out of it', async () => {
    const many: Conflict[] = Array.from({ length: 2000 }, (_, index) => ({
      ...freshConflict, id: `many-${index}`, sectionKey: `s${index}`, section: `Section ${index}`, title: `Section ${index} — Primary database`,
    }))
    mocks.useStore.mockReturnValue(storeWith(many, many[0].id))
    await act(async () => root.render(<Conflicts />))

    // One group of 2,000 items, open — the DOM holds a window of it, not all of it.
    const mounted = itemRows().length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(40)
    expect(container.querySelector<HTMLElement>('.cc-conflict-virtual')?.style.height).toBe(`${44 + 2000 * 128}px`)

    const stop = $$('.cc-conflict-list [role="option"][tabindex="0"]')[0]
    await act(async () => stop.focus())
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- one keystroke at a time is the point
      await act(async () => press(active()!, 'ArrowDown'))
    }
    // The tab stop starts on the current row (Section 0); sixty steps down is
    // far outside the first window: it is focused, it is in the DOM, and the
    // DOM is still small — the row is rendered BECAUSE it has focus.
    expect(active()?.getAttribute('role')).toBe('option')
    expect(active()?.textContent).toContain('Section 60')
    expect(document.activeElement).not.toBe(document.body)
    expect(itemRows().length).toBeLessThan(80)
    expect($$('.cc-conflict-list [role="option"][tabindex="0"]')).toHaveLength(1)

    // The wheel, not the keyboard: the window moves out from under the focused row.
    const scroller = container.querySelector<HTMLElement>('.cc-conflict-list')!
    Object.defineProperty(scroller, 'scrollTop', { value: 200_000, configurable: true, writable: true })
    await act(async () => scroller.dispatchEvent(new Event('scroll')))
    expect(itemRows().map((row) => row.textContent).some((text) => text?.includes('Section 60'))).toBe(true)
    expect(document.activeElement?.textContent).toContain('Section 60')
    expect(itemRows().filter((row) => /Section 15\d\d/.test(row.textContent ?? '')).length).toBeGreaterThan(3)
  })
})

describe('Discrepancy Center — copy helpers', () => {
  it('previewSentence says how many files change across how many layers, and what cannot be applied', () => {
    const preview: DiscrepancyBatchResponse = {
      ok: false, applied: 0, failed: 0, suggestions: [],
      results: [
        { discrepancyId: 'a', ok: true, wouldWrite: [{ layer: 'personal', path: 'notes/a.md' }] },
        { discrepancyId: 'b', ok: true, wouldWrite: [{ layer: 'team', path: 'notes/b.md' }, { layer: 'personal', path: 'notes/a.md' }] },
        { discrepancyId: 'c', ok: false, code: 'STALE', error: 'The record changed since you loaded it.' },
      ],
    }
    expect(previewSentence(preview)).toBe('2 files change across 2 layers for 2 items. 1 cannot be applied (The record changed since you loaded it.).')
    expect(previewSentence({ ...preview, results: preview.results.slice(0, 2).map((result) => ({ ...result, wouldWrite: [] })) }, { acknowledging: true })).toBe('No files change. 2 items move to Acknowledged.')
    expect(previewSentence({ ...preview, fallback: 'sequential', results: [{ discrepancyId: 'a', ok: true }] })).toBe('This engine cannot preview changes; 1 decision will apply one at a time.')
    expect(previewSentence({ ...preview, results: [{ discrepancyId: 'a', ok: true }] }, { demo: true })).toContain('Simulation — nothing changes on disk')
  })

  it('renders a * match as "any" and a rewrite action as "Rewrite → target" in the rules panel', () => {
    expect(matchLabel({ kind: 'broken_link', conceptType: '*', key: '*', sources: ['personal'], target: 'decisions/old' })).toBe('Broken link · any type · any key · personal · → decisions/old')
    expect(matchLabel({ kind: 'section_content', conceptType: 'decision', key: 'choice', sources: ['personal', 'team'] })).toBe('Section content · decision · choice · personal + team')
    expect(actionLabel({ type: 'rewrite_link', newTarget: 'decisions/new' })).toBe('Rewrite → decisions/new')
    expect(actionLabel({ type: 'prefer_source', source: 'team' })).toBe('Prefer team')
    expect(actionLabel({ type: 'acknowledge', reasonCode: 'target_missing' })).toBe('Acknowledge as target missing')
  })

  it('shows a rule with wildcards and a generalized suggestion in the panel', async () => {
    const store = storeWith([freshConflict], freshConflict.id)
    ;(store as unknown as { discrepancyRules: unknown[] }).discrepancyRules = [{
      id: 'rule-1', scope: 'local', mode: 'recommend', enabled: true,
      match: { kind: 'broken_link', conceptType: '*', key: '*', sources: ['personal'], target: 'decisions/old' },
      action: { type: 'rewrite_link', newTarget: 'decisions/new' }, evidenceDecisionIds: ['d1', 'd2', 'd3'],
    }]
    ;(store as unknown as { discrepancyRuleSuggestions: unknown[] }).discrepancyRuleSuggestions = [{
      id: 'sug-1', match: { kind: 'section_content', conceptType: '*', key: '*', sources: ['personal', 'team'] },
      action: { type: 'prefer_source', source: 'team' }, evidenceDecisionIds: ['d4', 'd5', 'd6'], evidenceCount: 3, generalized: true,
    }]
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))
    const rules = container.querySelector('.cc-rules')!
    expect(rules.textContent).toContain('Rewrite → decisions/new')
    expect(rules.textContent).toContain('any type · any key')
    expect(rules.textContent).toContain('Suggested from 3 decisions across several sections')
    expect(rules.textContent).toContain('Prefer team')
  })
})
