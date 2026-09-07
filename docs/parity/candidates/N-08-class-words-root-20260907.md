# N-08 character-class word semantics — root accepted

The default AST matcher now preserves the native compiler's distinction between
bare bracketed words and plain parenthesized words inside brackets. `[georgia]`
requires that spelling; `[(time)s]` expands the parenthesized equivalent and can
accept `thymes`. Surrounding characters and suffixes retain their own meaning.

Root independently regenerated eight native grammars and their parser outputs.
The candidate matches 19 of 21 acceptance controls, up from 15; two apostrophe
cases remain a separate unverified candidate. The unchanged full HTTP replay on
frozen `969725b` completed all 20,528 requests: 20,476 matches, 52 differences,
five repairs, no newly failing cases and no changed shared residuals. It measures
HTTP status and data; full transport/action coverage belongs to the separately
tracked production profile.

The combined installer/class checkpoint `939c670` preserves the reviewed component
bytes and passes 675 unit tests, seven skips and strict43 with zero differences,
invariants or gaps. The [root review](../evidence/2026-09-07/nlu-class-words/review.json)
pins inputs, executable source controls, terminal receipts and reconciliation.
Complete N-08 remains open and receives no checklist completion credit.
