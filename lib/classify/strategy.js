// Router strategy seam: the classify step every tier-selection implementation
// satisfies.
//
// Derived from OpenSquilla (https://github.com/opensquilla/opensquilla),
// Apache-2.0 © OpenSquilla contributors — behavioral port of the
// `RouterStrategy` protocol in `opensquilla/engine/steps/squilla_router.py`.
// See NOTICE.md.
/** Strategies ranked by preference; the first READY one serves a turn. */
export const STRATEGY_SOURCE_RANK = ['remote', 'heuristic'];
