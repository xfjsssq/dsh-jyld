// Data tables for the post-classifier routing policy.
//
// Derived from OpenSquilla (https://github.com/opensquilla/opensquilla),
// Apache-2.0 © OpenSquilla contributors — behavioral port of
// `opensquilla/engine/routing/policy_data.py` plus the prompt-policy hint
// strings from `opensquilla/squilla_router/controller.py`. See NOTICE.md.
/** Material-context floor that forces c2. */
export const LARGE_CONTEXT_T2_FLOOR_TOKENS = 25_000;
/** Material-context floor that forces the highest text tier. */
export const LARGE_CONTEXT_T3_FLOOR_TOKENS = 80_000;
/** Fraction of the context window that also forces the highest text tier. */
export const LARGE_CONTEXT_T3_CONTEXT_RATIO = 0.4;
/** Context window assumed when a tier model has no declared window. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const THINKING_MODE_ORDER = { T0: 0, T1: 1, T2: 2, T3: 3 };
/**
 * Complaint vocabulary triggering a one-step tier upgrade on short follow-ups.
 * zh/en only by design, preserved as-is from upstream.
 */
export const COMPLAINT_TERMS = [
    '不对',
    '不行',
    '不对劲',
    '还是不对',
    '完全不对',
    '不是这样',
    '你搞错了',
    '你说错了',
    '回答错了',
    '理解错了',
    '搞错重点了',
    '错了',
    '答非所问',
    '没理解',
    '没听懂',
    '太差',
    '太敷衍',
    '敷衍',
    '没用',
    '废话',
    '离谱',
    '乱说',
    '瞎说',
    '胡扯',
    '答得太差',
    '质量太差',
    '不满意',
    '胡说',
    '漏了',
    '遗漏了',
    '没提到',
    '没覆盖',
    '跑题了',
    '偏题了',
    '不是我要的',
    '没按要求',
    '没有按要求',
    '重写',
    '重新来',
    '重新回答',
    '再来一版',
    '换个说法',
    '重新组织',
    '按我说的重来',
    '你没有回答',
    '垃圾',
    '傻逼',
    'sb',
    '蠢',
    '废物',
    '滚',
    '妈的',
    '操',
    '艹',
    'wrong',
    'incorrect',
    'not correct',
    'you are wrong',
    'completely wrong',
    'totally wrong',
    'not what i asked',
    'you misunderstood',
    "that's not right",
    'this is not right',
    'bad answer',
    'terrible answer',
    'awful answer',
    'horrible answer',
    'poor answer',
    'lazy answer',
    'low quality',
    'poor quality',
    'try again',
    'redo',
    'rewrite',
    'start over',
    'answer again',
    'you missed',
    'missed the point',
    'off topic',
    'irrelevant',
    'not helpful',
    'garbage',
    'trash',
    'crap',
    'sucks',
    'stupid',
    'idiot',
    'moron',
    'dumb',
    'pathetic',
    'ridiculous',
    'fuck',
    'fucking',
    'shit',
    'damn',
    'wtf',
    'asshole',
    'bullshit',
    'nonsense',
    'useless',
];
/**
 * The P0 compression hint injected into the user text when the controller
 * picks the low-expansion prompt policy. Upstream skips the hint for P2 and
 * is idempotent about repeats.
 */
export const PROMPT_HINT_EN = 'Answer directly, keep thinking short, avoid irrelevant expansion.';
export const PROMPT_HINT_ZH = '直接作答，缩短思考长度，避免无关展开。';
