// @vitest-environment jsdom
// Professional discrepancy presentation and governed decision affordances.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conflicts } from './Conflicts'
import type { Conflict } from '../data'

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
