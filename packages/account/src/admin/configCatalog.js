// The settings catalogue behind the console's Settings page.
//
// Every entry is one environment variable a Phoenix service reads, described the
// way an administrator thinks about it. There are two kinds:
//
//   * Editable settings are part of what Phoenix does: speech recognition, how
//     Jibo understands and answers, the personal report, email, logging. An
//     administrator changes them from the console. The console saves them in the
//     data directory (consoleSettings.js), layered over the server's environment
//     file, and the launcher applies them when it starts the services that read
//     them. `restart` names exactly those services, so the console restarts no
//     more than it has to.
//
//   * Server settings are part of how this server is installed: its public
//     addresses, secrets shared between services, where data is stored, which
//     parser runtime it uses. A wrong value here can stop robots connecting or
//     the console starting, so the console only shows them. They are changed in
//     the server's environment file, then Phoenix is restarted.
//
// Only settings the launcher passes through to the services that use them are
// editable: a value the launcher overrides for a service would be saved and then
// never used, which is worse than not offering it.
//
// Adding a setting: add it to the group it belongs to. The console renders
// whatever this file declares.

/**
 * The services the native launcher runs (scripts/run-compose-stack.sh), by the
 * names it gives them. These are what the console can restart.
 */
export const SERVICES = {
  hub: {
    label: 'Voice gateway',
    description: 'Robots connect here. It streams what they hear to recognition, understanding and the skills.',
  },
  parser: {
    label: 'Language understanding',
    description: 'Works out what someone asked for.',
  },
  'answer-skill': {
    label: 'Answers',
    description: 'Answers general questions.',
  },
  'report-skill': {
    label: 'Personal report',
    description: 'Reads each person’s weather, news, commute and calendar.',
  },
  'chitchat-skill': {
    label: 'Conversation',
    description: 'Jibo’s personality: small talk, jokes, songs and dances.',
  },
  'color-skill': {
    label: 'Color skill',
    description: 'A short conversation about favorite colors.',
  },
  history: {
    label: 'History',
    description: 'Remembers which skills ran, so Jibo can follow up.',
  },
  lasso: {
    label: 'Data relay',
    description: 'Fetches weather, news, commute times and calendars.',
  },
  classic: {
    label: 'Robot cloud API',
    description: 'The robot’s front door for its account, photos, messages, backups and updates.',
  },
  account: {
    label: 'Console and accounts',
    description: 'This website, sign-in, households and robot setup.',
  },
  ota: {
    label: 'Software updates',
    description: 'Serves update packages to robots.',
  },
  'example-skill': {
    label: 'Example skill',
    description: 'A developer template. Robots never use it.',
    minor: true,
  },
  'template-skill': {
    label: 'Template skill',
    description: 'A developer template. Robots never use it.',
    minor: true,
  },
};

export const SERVICE_IDS = Object.keys(SERVICES);

/** Every service, for settings that all of them read (the log level). */
const EVERY_SERVICE = SERVICE_IDS;

/** Groups, in the order the console shows them. `editable: false` groups are read-only. */
export const GROUPS = [
  {
    id: 'speech',
    label: 'Speech recognition',
    blurb: 'Turning what people say to Jibo into text.',
    icon: 'mic',
    editable: true,
  },
  {
    id: 'understanding',
    label: 'Understanding',
    blurb: 'Working out what someone meant when Jibo’s own grammar isn’t sure.',
    icon: 'message',
    editable: true,
  },
  {
    id: 'answers',
    label: 'Answers',
    blurb: 'Where Jibo looks things up when someone asks him a question.',
    icon: 'sparkles',
    editable: true,
  },
  {
    id: 'model',
    label: 'Language model',
    blurb: 'An OpenAI-compatible model, for the services set to use one.',
    icon: 'chip',
    editable: true,
  },
  {
    id: 'report',
    label: 'Personal report',
    blurb: 'Data behind the report Jibo reads to each person.',
    icon: 'sun',
    editable: true,
  },
  {
    id: 'mail',
    label: 'Email',
    blurb: 'How this server sends invitations, confirmations and password resets.',
    icon: 'mail',
    editable: true,
  },
  {
    id: 'data',
    label: 'Logs and data',
    blurb: 'What this server writes down, and for how long it keeps it.',
    icon: 'inbox',
    editable: true,
  },
  {
    id: 'addresses',
    label: 'Addresses',
    blurb: 'How robots and browsers reach this server.',
    icon: 'link',
    editable: false,
  },
  {
    id: 'security',
    label: 'Security',
    blurb: 'Secrets the services share, and who may connect.',
    icon: 'lock',
    editable: false,
  },
  {
    id: 'storage',
    label: 'Storage',
    blurb: 'Where this server keeps its data and logs.',
    icon: 'download',
    editable: false,
  },
  {
    id: 'software',
    label: 'Software',
    blurb: 'Which implementations run, and the site’s own pages.',
    icon: 'server',
    editable: false,
  },
];

export const GROUP_IDS = new Set(GROUPS.map((group) => group.id));

/**
 * @typedef {object} Setting
 * @property {string}   key        the environment variable
 * @property {string}   label      short human name
 * @property {string}   group      one of GROUPS[].id
 * @property {string}   type       string|secret|bool|number|url|host|email|enum|path
 * @property {boolean} [editable]  true when the console may change it (its group must be editable)
 * @property {string[]} [restart]  launcher services that read it (editable settings only)
 * @property {string?} [default]   the built-in value, as shown, or null when there is none to show
 * @property {string}   help       what it does, and what changing it does
 * @property {boolean} [advanced]  hidden under "More settings" until asked for
 * @property {Array}   [options]   for type 'enum': {value, label, hint?}
 * @property {string}  [placeholder]
 * @property {number}  [min] @property {number} [max] @property {boolean} [integer]
 * @property {string}  [unit]      shown after a number: 'ms', 'days'
 */

/** @type {Setting[]} */
export const SETTINGS = [
  /* ── Speech recognition ─────────────────────────────────────────────── */
  {
    key: 'PHOENIX_ASR_PROVIDER', label: 'Speech recognizer', group: 'speech', type: 'enum',
    editable: true, restart: ['hub'], default: 'parakeet',
    options: [
      { value: 'parakeet', label: 'Parakeet', hint: 'Use the self-hosted recognizer.' },
      { value: 'auto', label: 'Parakeet with Google fallback', hint: 'Send audio to Google when Parakeet cannot answer, within the usage limits.' },
      { value: 'google', label: 'Google', hint: 'Use Google and leave the GPU free, within the usage limits.' },
    ],
    help: 'Google sends recordings and recognition hints to Google Cloud. Set up its project and credentials '
      + 'on the server first. A saved choice takes effect when the voice gateway restarts.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_PROJECT', label: 'Google Cloud project', group: 'speech', type: 'string',
    editable: true, restart: ['hub'], default: null, advanced: true,
    help: 'The project billed for Speech-to-Text. Its billing account must have the credits you want to use.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_MODEL', label: 'Google speech model', group: 'speech', type: 'enum',
    editable: true, restart: ['hub'], default: 'chirp_3', advanced: true,
    options: [{ value: 'chirp_3', label: 'Chirp 3' }, { value: 'chirp_2', label: 'Chirp 2' }],
    help: 'Chirp 3 is the recommended model. Recognition quality and latency still need a comparison on a robot.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_LOCATION', label: 'Google processing location', group: 'speech', type: 'enum',
    editable: true, restart: ['hub'], default: 'us', advanced: true,
    options: [{ value: 'us', label: 'United States (Chirp 3)' }, { value: 'eu', label: 'European Union (Chirp 3)' },
      { value: 'us-central1', label: 'Iowa (Chirp 2)' }, { value: 'europe-west4', label: 'Netherlands (Chirp 2)' },
      { value: 'asia-southeast1', label: 'Singapore (Chirp 2)' }],
    help: 'Selects the Speech-to-Text endpoint and recognizer location. Chirp 3 uses US or EU; Chirp 2 uses a listed region. Verify project access before choosing Chirp 2.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_MONTHLY_MINUTES', label: 'Google monthly limit', group: 'speech', type: 'number',
    editable: true, restart: ['hub'], default: '560', min: 0, max: 100000, unit: 'minutes',
    help: 'A hard limit on conservatively counted audio each Pacific calendar month. At $0.016/minute, '
      + '560 minutes costs at most $8.96 before other usage or taxes. Set 0 to disable Google. Credits are applied by Google Billing.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_DAILY_MINUTES', label: 'Google daily limit', group: 'speech', type: 'number',
    editable: true, restart: ['hub'], default: null, min: 0, max: 100000, unit: 'minutes', advanced: true,
    help: 'Stops one day using the whole month. Unset means one tenth of the monthly limit, rounded up '
      + '(56 minutes with the default). Set 0 for no daily limit.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_MAX_STREAMS', label: 'Google concurrent streams', group: 'speech', type: 'number',
    editable: true, restart: ['hub'], default: '8', min: 1, max: 8, integer: true, advanced: true,
    help: 'Limits simultaneous streaming calls. Each stream uses roughly five audio requests per second.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_DENOISE', label: 'Google denoising', group: 'speech', type: 'bool',
    editable: true, restart: ['hub'], default: 'false', advanced: true,
    help: 'Optional Chirp audio denoising. Leave off until tested with the room and robot microphone.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_HINT_BOOST', label: 'Google hint boost', group: 'speech', type: 'number',
    editable: true, restart: ['hub'], default: null, min: 0, max: 20, advanced: true,
    help: 'Optional speech-adaptation boost. Unset sends phrases without a boost, as the original Jibo request did.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_CREDENTIALS_FILE', label: 'Google credentials file', group: 'speech', type: 'path',
    default: null, advanced: true,
    help: 'Server-owned path to private service-account or federation credentials. Install the file outside the release and Git; never paste its contents here.',
  },
  {
    key: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Default Google credentials file', group: 'speech', type: 'path',
    default: null, advanced: true,
    help: 'Used when the explicit Google speech credentials file is unset. This is a path, never the credential contents.',
  },
  {
    key: 'PHOENIX_GOOGLE_STT_USAGE_FILE', label: 'Google speech usage ledger', group: 'speech', type: 'path',
    default: null, advanced: true,
    help: 'A durable server-owned file. Defaults to PHOENIX_DATA_DIR/asr/google-stt-usage.json. Initialize once with '
      + 'scripts/init-google-stt-usage.mjs; missing or damaged usage state keeps Google off.',
  },
  {
    key: 'PARAKEET_URL',
    label: 'Recognition server',
    group: 'speech',
    type: 'url',
    editable: true,
    restart: ['hub'],
    default: null,
    placeholder: 'http://192.168.1.252:6972',
    help: 'The Parakeet server that turns what people say into text. Phoenix sends it each recording '
      + '(POST /transcribe). Without one, Jibo hears “Hey Jibo” but not the question.',
  },
  {
    key: 'PHOENIX_ASR_SILENCE_EOS_MS',
    label: 'Pause that ends a question',
    group: 'speech',
    type: 'number',
    unit: 'ms',
    integer: true,
    editable: true,
    restart: ['hub'],
    default: null,
    min: 150,
    max: 5000,
    placeholder: 'Built-in',
    help: 'How long someone must stop talking before Jibo decides they have finished. Shorter feels '
      + 'snappier but cuts off people who pause mid-sentence.',
  },
  {
    key: 'PHOENIX_ASR_NOISE_MARGIN',
    label: 'Noise margin',
    group: 'speech',
    type: 'number',
    editable: true,
    advanced: true,
    restart: ['hub'],
    default: '1.8',
    min: 1,
    max: 10,
    help: 'How far above the room’s background noise sound must rise to count as speech. Raise it in a '
      + 'noisy room if Jibo keeps listening to nothing.',
  },

  /* ── Understanding ──────────────────────────────────────────────────── */
  {
    key: 'ETCO_parser_decisionEngine',
    label: 'Decision layer',
    group: 'understanding',
    type: 'enum',
    editable: true,
    restart: ['parser'],
    default: '',
    options: [
      { value: '', label: 'Off', hint: 'Only Jibo’s own grammar decides.' },
      { value: 'jev', label: 'Jev, through OpenRouter',
        hint: 'Recognizes other ways of saying a command, like “what day is it today”.' },
    ],
    help: 'Reviews what Jibo’s grammar made of each request and maps other phrasings onto his '
      + 'commands. It sends the text of reviewed requests to OpenRouter and TypeSafe, so the privacy '
      + 'policy has to say so first. See docs/DECISION-LAYER.md.',
  },
  {
    key: 'ETCO_parser_decisionApiKey',
    label: 'Decision layer key',
    group: 'understanding',
    type: 'secret',
    editable: true,
    restart: ['parser', 'lasso'],
    default: null,
    help: 'An OpenRouter key for the decision layer. Without one the layer stays off.',
  },
  {
    key: 'ETCO_parser_decisionModel',
    label: 'Decision model',
    group: 'understanding',
    type: 'string',
    editable: true,
    advanced: true,
    restart: ['parser'],
    default: 'typesafe/jev-1.13',
    help: 'Pinned to the model the decision layer was evaluated with. Re-run the evaluation '
      + '(scripts/decision-layer-eval.mjs) before changing it.',
  },
  {
    key: 'ETCO_parser_decisionTimeoutMs',
    label: 'Decision time limit',
    group: 'understanding',
    type: 'number',
    unit: 'ms',
    integer: true,
    editable: true,
    advanced: true,
    restart: ['parser'],
    default: '800',
    min: 50,
    max: 5000,
    help: 'A slower answer keeps the grammar’s own result, so Jibo never waits long for it.',
  },
  {
    key: 'ETCO_parser_decisionMinProbability',
    label: 'Decision confidence',
    group: 'understanding',
    type: 'number',
    editable: true,
    advanced: true,
    restart: ['parser'],
    default: '0.5',
    min: 0,
    max: 1,
    help: 'How sure the decision layer must be to replace a result the grammar wasn’t sure of.',
  },
  {
    key: 'ETCO_parser_decisionOverrideProbability',
    label: 'Override confidence',
    group: 'understanding',
    type: 'number',
    editable: true,
    advanced: true,
    restart: ['parser'],
    default: '0.9',
    min: 0,
    max: 1,
    help: 'How sure it must be to replace a confident grammar result that isn’t a command.',
  },
  {
    key: 'ETCO_parser_layaEnabled',
    label: 'Laya intent classifier',
    group: 'understanding',
    type: 'bool',
    editable: true,
    restart: ['parser'],
    default: 'false',
    help: 'Asks a private Laya classifier when the grammar isn’t confident. Leave it off until the '
      + 'classifier, its token and the replay evaluation are verified. It must never be reachable '
      + 'from the internet.',
  },
  {
    key: 'ETCO_parser_layaUrl',
    label: 'Laya address',
    group: 'understanding',
    type: 'url',
    editable: true,
    restart: ['parser'],
    default: null,
    placeholder: 'http://192.168.1.252:6973',
    help: 'The classifier’s address on your private network or VPN.',
  },
  {
    key: 'ETCO_parser_layaToken',
    label: 'Laya token',
    group: 'understanding',
    type: 'secret',
    editable: true,
    restart: ['parser'],
    default: null,
    help: 'The token shared with the classifier. It is required even on a private network.',
  },
  {
    key: 'ETCO_parser_layaProfile',
    label: 'Laya profile',
    group: 'understanding',
    type: 'string',
    editable: true,
    advanced: true,
    restart: ['parser'],
    default: 'phoenix-core',
    help: 'Which set of intents the classifier may choose from. The default only allows simple commands.',
  },
  {
    key: 'ETCO_parser_layaTimeoutMs',
    label: 'Laya time limit',
    group: 'understanding',
    type: 'number',
    unit: 'ms',
    integer: true,
    editable: true,
    advanced: true,
    restart: ['parser'],
    default: '700',
    min: 50,
    max: 2000,
    help: 'A slower answer leaves the grammar’s result in place.',
  },
  {
    key: 'ETCO_parser_layaMinConfidence',
    label: 'Laya confidence',
    group: 'understanding',
    type: 'number',
    editable: true,
    advanced: true,
    restart: ['parser'],
    default: '0.85',
    min: 0,
    max: 1,
    help: 'How likely the classifier’s choice must be before Jibo acts on it.',
  },
  {
    key: 'ETCO_parser_layaSecondaryFallback',
    label: 'After Laya finds nothing',
    group: 'understanding',
    type: 'enum',
    editable: true,
    advanced: true,
    restart: ['parser'],
    default: 'none',
    options: [
      { value: 'none', label: 'Stop there' },
      { value: 'llm', label: 'Ask the language model' },
    ],
    help: 'Whether the language model gets a last try at working out the request.',
  },

  /* ── Answers ────────────────────────────────────────────────────────── */
  {
    key: 'PHOENIX_GQA_DEFAULT_PROFILE',
    label: 'How Jibo answers questions',
    group: 'answers',
    type: 'enum',
    editable: true,
    restart: ['answer-skill'],
    default: '',
    options: [
      { value: '', label: 'Look it up',
        hint: 'Wikipedia, DuckDuckGo and Wolfram|Alpha, as the original Jibo did.' },
      { value: 'phoenix-answer', label: 'Ask the language model',
        hint: 'Uses the language model settings below.' },
    ],
    help: 'Who answers questions like “Who was Ada Lovelace?” or “How far away is the moon?”.',
  },
  {
    key: 'ETCO_gqa_wolframKey',
    label: 'Wolfram|Alpha app ID',
    group: 'answers',
    type: 'secret',
    editable: true,
    restart: ['answer-skill'],
    default: null,
    help: 'Lets Jibo answer measurements, distances, populations and arithmetic. Get one at '
      + 'developer.wolframalpha.com; a free app ID allows 2,000 questions a month.',
  },
  {
    key: 'ETCO_gqa_wikiUserAgent',
    label: 'Wikipedia identity',
    group: 'answers',
    type: 'string',
    editable: true,
    restart: ['answer-skill'],
    default: 'wikipedia (https://github.com/goldsmith/Wikipedia/)',
    placeholder: 'PhoenixJibo/1.0 (https://example.com; you@example.com)',
    help: 'How Phoenix introduces itself to Wikipedia. Wikipedia throttles the original shared name, so '
      + 'give your own, with a web address or email it can contact.',
  },
  {
    key: 'ETCO_gqa_providerTimeoutMs',
    label: 'Wikipedia and DuckDuckGo time limit',
    group: 'answers',
    type: 'number',
    unit: 'ms',
    integer: true,
    editable: true,
    advanced: true,
    restart: ['answer-skill'],
    default: '3000',
    min: 0,
    max: 20000,
    help: 'How long the first sources get before Wolfram|Alpha is asked as well.',
  },
  {
    key: 'ETCO_gqa_wolframGroupTimeoutMs',
    label: 'Wolfram|Alpha time limit',
    group: 'answers',
    type: 'number',
    unit: 'ms',
    integer: true,
    editable: true,
    advanced: true,
    restart: ['answer-skill'],
    default: '4000',
    min: 0,
    max: 20000,
    help: 'How long Wolfram|Alpha gets before Jibo says he couldn’t find an answer.',
  },
  {
    key: 'ETCO_gqa_wikiApi',
    label: 'Wikipedia address',
    group: 'answers',
    type: 'url',
    editable: true,
    advanced: true,
    restart: ['answer-skill'],
    default: 'https://en.wikipedia.org/w/api.php',
    help: 'The MediaWiki API Phoenix looks articles up in.',
  },
  {
    key: 'ETCO_gqa_duckDuckGoApi',
    label: 'DuckDuckGo address',
    group: 'answers',
    type: 'url',
    editable: true,
    advanced: true,
    restart: ['answer-skill'],
    default: 'https://api.duckduckgo.com/',
    help: 'The instant-answer API Phoenix asks alongside Wikipedia.',
  },

  /* ── Language model ─────────────────────────────────────────────────── */
  {
    key: 'LLM_URL',
    label: 'Endpoint',
    group: 'model',
    type: 'url',
    editable: true,
    restart: ['parser', 'answer-skill'],
    default: null,
    placeholder: 'https://openrouter.ai/api/v1',
    help: 'An OpenAI-compatible API: OpenRouter, LM Studio, Ollama, vLLM. Used by Answers when it is set '
      + 'to ask the language model, and by Understanding as a last resort.',
  },
  {
    key: 'LLM_MODEL',
    label: 'Model',
    group: 'model',
    type: 'string',
    editable: true,
    restart: ['parser', 'answer-skill'],
    default: 'google/gemma-4-e4b',
    help: 'The model to ask for at that endpoint.',
  },
  {
    key: 'PHOENIX_LLM_API_KEY',
    label: 'API key',
    group: 'model',
    type: 'secret',
    editable: true,
    restart: ['parser', 'answer-skill', 'lasso'],
    default: null,
    help: 'Sent as a bearer token. Leave it empty for a local model that needs none.',
  },

  /* ── Personal report ────────────────────────────────────────────────── */
  {
    key: 'PHOENIX_NEWS_BRIEFINGS_ENABLED', label: 'News briefings', group: 'report',
    type: 'bool', editable: true, restart: ['lasso', 'report-skill'], default: 'false',
    help: 'Prepare shared, expressive news stories for Jibo, about twenty to thirty seconds each. '
      + 'Refreshes twice daily. Needs a World News key and an OpenRouter key; uses the existing feed while stories are unavailable.',
  },
  {
    key: 'WORLD_NEWS_API_KEY', label: 'World News API key', group: 'report',
    type: 'secret', editable: true, restart: ['lasso'], default: null,
    help: 'Article text for news briefings. Get a key at worldnewsapi.com. The default schedule is designed for the free daily quota.',
  },
  {
    key: 'PHOENIX_NEWS_REFRESH_HOURS', label: 'News refresh interval', group: 'report',
    type: 'number', editable: true, restart: ['lasso'], default: '12', min: 6, max: 24, unit: 'hours',
    help: 'Refresh all categories on this interval. Shared stories are reused across people and robots.',
  },
  {
    key: 'PHOENIX_NEWS_DAILY_LLM_USD', label: 'News model daily budget', group: 'report',
    type: 'number', editable: true, restart: ['lasso'], default: '0.15', min: 0, max: 5, unit: 'USD',
    help: 'Daily spending allowance for generating news, with reservations before each request. Zero pauses generation.',
  },
  {
    key: 'ETCO_news_llmModel', label: 'News model', group: 'report',
    type: 'string', editable: true, advanced: true, restart: ['lasso'], default: 'deepseek/deepseek-v4.1-flash',
    help: 'An OpenRouter model supporting structured JSON output. Generation enforces a low token-price ceiling.',
  },
  {
    key: 'ETCO_news_llmApiKey', label: 'News model key', group: 'report',
    type: 'secret', editable: true, advanced: true, restart: ['lasso'], default: null,
    help: 'Optional OpenRouter key just for news. Otherwise reuses the shared model key or the decision layer key.',
  },
  {
    key: 'TOMTOM_API_KEY',
    label: 'TomTom key',
    group: 'report',
    type: 'secret',
    editable: true,
    restart: ['lasso'],
    default: null,
    help: 'Commute times and live traffic. Without a key, Jibo can’t tell anyone how long their commute '
      + 'will take. Weather and the basic RSS news feed need no key.',
  },
  {
    key: 'ETCO_data_calendarUpstreamUrl',
    label: 'Calendar service',
    group: 'report',
    type: 'url',
    editable: true,
    advanced: true,
    restart: ['lasso'],
    default: null,
    help: 'A service that serves people’s calendar events to the report. Without one, Jibo reads only '
      + 'calendars people subscribe to from the console.',
  },
  {
    key: 'ETCO_data_calendarUpstreamToken',
    label: 'Calendar service token',
    group: 'report',
    type: 'secret',
    editable: true,
    advanced: true,
    restart: ['lasso'],
    default: null,
    help: 'The bearer token for that calendar service.',
  },

  /* ── Email ──────────────────────────────────────────────────────────── */
  {
    key: 'ETCO_account_mailFrom',
    label: 'Sender address',
    group: 'mail',
    type: 'email',
    editable: true,
    restart: ['account'],
    default: 'no-reply@jibo.com',
    placeholder: 'phoenix@example.com',
    help: 'The From address on every email this server sends. Use one your mail server may send as.',
  },
  {
    key: 'ETCO_account_mailSmtpHost',
    label: 'Mail server',
    group: 'mail',
    type: 'host',
    editable: true,
    restart: ['account'],
    default: null,
    placeholder: 'smtp.example.com',
    help: 'The SMTP server that delivers email. Without one, nobody can confirm a new account or reset a '
      + 'password by email.',
  },
  {
    key: 'ETCO_account_mailSmtpPort',
    label: 'Mail server port',
    group: 'mail',
    type: 'number',
    integer: true,
    editable: true,
    restart: ['account'],
    default: null,
    min: 1,
    max: 65535,
    placeholder: '587',
    help: 'Usually 587, or 465 when the connection is encrypted from the start.',
  },
  {
    key: 'ETCO_account_mailSmtpSecure',
    label: 'Encrypted from the start',
    group: 'mail',
    type: 'bool',
    editable: true,
    restart: ['account'],
    default: 'false',
    help: 'On for port 465. Off for 587, where the connection is upgraded with STARTTLS.',
  },
  {
    key: 'ETCO_account_mailSmtpUser',
    label: 'Mail username',
    group: 'mail',
    type: 'string',
    editable: true,
    restart: ['account'],
    default: null,
    help: 'The account this server signs in to the mail server with.',
  },
  {
    key: 'ETCO_account_mailSmtpPassword',
    label: 'Mail password',
    group: 'mail',
    type: 'secret',
    editable: true,
    restart: ['account'],
    default: null,
    help: 'That account’s password, or an app password.',
  },
  {
    key: 'ETCO_account_mailSmtpRequireTLS',
    label: 'Require STARTTLS',
    group: 'mail',
    type: 'bool',
    editable: true,
    advanced: true,
    restart: ['account'],
    default: 'false',
    help: 'Refuse to send if the mail server won’t upgrade the connection to an encrypted one.',
  },
  {
    key: 'ETCO_account_mailSmtpTimeoutMs',
    label: 'Mail time limit',
    group: 'mail',
    type: 'number',
    unit: 'ms',
    integer: true,
    editable: true,
    advanced: true,
    restart: ['account'],
    default: null,
    min: 1000,
    max: 120000,
    help: 'How long to wait for the mail server before giving up on a message.',
  },
  {
    key: 'ETCO_account_smsUrl',
    label: 'Text message gateway',
    group: 'mail',
    type: 'url',
    editable: true,
    advanced: true,
    restart: ['account'],
    default: null,
    help: 'An HTTP endpoint that sends phone-number confirmation codes by text. Without one, phone '
      + 'numbers can’t be confirmed.',
  },

  /* ── Logs and data ──────────────────────────────────────────────────── */
  {
    key: 'LOG_LEVEL',
    label: 'Log detail',
    group: 'data',
    type: 'enum',
    editable: true,
    restart: EVERY_SERVICE,
    default: 'info',
    options: [
      { value: 'error', label: 'Errors only' },
      { value: 'warn', label: 'Errors and warnings' },
      { value: 'info', label: 'Normal', hint: 'Recommended.' },
      { value: 'debug', label: 'Everything', hint: 'For diagnosing a problem. Fills disks over time.' },
    ],
    help: 'How much every service writes to its log, and so what the Logs page can show.',
  },
  {
    key: 'PHOENIX_VOICE_TURN_RETAIN_MS',
    label: 'Keep voice-turn timings for',
    group: 'data',
    type: 'enum',
    editable: true,
    restart: ['hub'],
    default: '86400000',
    options: [
      { value: '900000', label: '15 minutes' },
      { value: '3600000', label: '1 hour' },
      { value: '21600000', label: '6 hours' },
      { value: '86400000', label: '24 hours' },
    ],
    help: 'How far back the Voice turns page reaches. Native deployments keep timings across restarts. '
      + 'They never include recordings, what was said, or who said it.',
  },
  {
    key: 'PHOENIX_DELETION_BACKUP_DAYS',
    label: 'Keep deleted accounts’ backups for',
    group: 'data',
    type: 'number',
    unit: 'days',
    integer: true,
    editable: true,
    restart: ['account', 'classic', 'history'],
    default: '30',
    min: 0,
    max: 3650,
    help: 'When someone deletes their account, each service first saves a backup, then deletes it after '
      + 'this many days. The privacy policy promises deleted data lingers only briefly. 0 keeps none.',
  },

  /* ── Addresses (server) ─────────────────────────────────────────────── */
  {
    key: 'PHOENIX_SITE_URL',
    label: 'Website',
    group: 'addresses',
    type: 'url',
    default: null,
    help: 'The public address of this site, used in links it sends.',
  },
  {
    key: 'ETCO_account_portalUrl',
    label: 'Console address',
    group: 'addresses',
    type: 'url',
    default: null,
    help: 'Where invitation and password-reset links point.',
  },
  {
    key: 'CLASSIC_PUBLIC_URL',
    label: 'Robot cloud address',
    group: 'addresses',
    type: 'url',
    default: null,
    help: 'The HTTPS origin robots reach the Robot cloud API at.',
  },
  {
    key: 'OTA_PUBLIC_URL',
    label: 'Update download address',
    group: 'addresses',
    type: 'url',
    default: null,
    help: 'Where robots download update packages from. A robot that can’t reach it fails an update partway.',
  },
  {
    key: 'PHOTO_PUBLIC_URL',
    label: 'Photo address',
    group: 'addresses',
    type: 'url',
    default: null,
    help: 'The public origin member photos are served from. Robots fetch them here.',
  },
  {
    key: 'ETCO_account_repointHost',
    label: 'Repoint address',
    group: 'addresses',
    type: 'string',
    default: null,
    help: 'The public IP the repoint command points a robot at.',
  },
  {
    key: 'ETCO_account_region',
    label: 'Robot region',
    group: 'addresses',
    type: 'string',
    default: 'api',
    help: 'Written into a robot’s credentials. It builds <region>.jibo.com from it, so the certificate '
      + 'must cover the same name.',
  },
  {
    key: 'PHOENIX_TLS_REGIONS',
    label: 'Certificate regions',
    group: 'addresses',
    type: 'string',
    default: 'api',
    help: 'Which <region>.jibo.com names the serving certificate covers.',
  },

  /* ── Security (server) ──────────────────────────────────────────────── */
  {
    key: 'HUB_TOKEN_SECRET',
    label: 'Robot token secret',
    group: 'security',
    type: 'secret',
    default: null,
    help: 'Signs the tokens robots use to reach the voice gateway. Changing it disconnects every robot '
      + 'until it signs in again.',
  },
  {
    key: 'DISABLE_AUTH',
    label: 'Accept robots without a token',
    group: 'security',
    type: 'bool',
    default: 'false',
    help: 'Only for bringing up a robot on a private network. Production refuses to start with it on.',
  },
  {
    key: 'ETCO_account_internalPeerToken',
    label: 'Service-to-service token',
    group: 'security',
    type: 'secret',
    default: null,
    help: 'Lets the services trust each other’s requests.',
  },
  {
    key: 'ETCO_ota_internalPeerToken',
    label: 'Update service token',
    group: 'security',
    type: 'secret',
    default: null,
    help: 'Lets the Robot cloud API ask the update service for its catalog.',
  },
  {
    key: 'ETCO_ota_packageBearerSecret',
    label: 'Package link secret',
    group: 'security',
    type: 'secret',
    default: null,
    help: 'Signs the download links in update offers. Without its own, the robot token secret is used.',
  },
  {
    key: 'ETCO_account_secureCookies',
    label: 'Secure session cookies',
    group: 'security',
    type: 'bool',
    default: 'true',
    help: 'Sign-in cookies are sent only over HTTPS.',
  },
  {
    key: 'ETCO_account_csrfOrigins',
    label: 'Trusted origins',
    group: 'security',
    type: 'string',
    default: null,
    help: 'Origins allowed to make changes through the console API.',
  },
  {
    key: 'ETCO_account_webPushPublicKey',
    label: 'Browser notification key',
    group: 'security',
    type: 'string',
    default: null,
    help: 'The public half of the key that signs browser notifications.',
  },
  {
    key: 'ETCO_account_webPushPrivateKey',
    label: 'Browser notification private key',
    group: 'security',
    type: 'secret',
    default: null,
    help: 'Generate a pair with scripts/generate-web-push-vapid.mjs.',
  },
  {
    key: 'PHOENIX_REQUIRE_PRODUCTION_CONFIG',
    label: 'Production checks',
    group: 'security',
    type: 'bool',
    default: 'false',
    help: 'Refuses to start without secrets, robot authentication and fixed HTTPS addresses.',
  },
  {
    key: 'PHOENIX_BIND_HOST',
    label: 'Listening address',
    group: 'security',
    type: 'string',
    default: '127.0.0.1',
    help: 'The address every service listens on. Only the reverse proxy should face the internet.',
  },

  /* ── Storage (server) ───────────────────────────────────────────────── */
  {
    key: 'PHOENIX_DATA_DIR',
    label: 'Data directory',
    group: 'storage',
    type: 'path',
    default: null,
    help: 'Accounts, photos, messages, robot backups, update packages and settings saved here.',
  },
  {
    key: 'PHOENIX_LOG_DIR',
    label: 'Log directory',
    group: 'storage',
    type: 'path',
    default: '/tmp',
    help: 'Where each service writes its log file.',
  },
  {
    key: 'ETCO_account_dataFile',
    label: 'Account store',
    group: 'storage',
    type: 'path',
    default: null,
    help: 'Accounts, households, robots and sessions.',
  },
  {
    key: 'PHOTO_DIRECTORY',
    label: 'Member photos',
    group: 'storage',
    type: 'path',
    default: null,
    help: 'Profile and member photos.',
  },
  {
    key: 'ETCO_ota_dataDir',
    label: 'Update packages',
    group: 'storage',
    type: 'path',
    default: null,
    help: 'The packages robots download.',
  },
  {
    key: 'ETCO_ota_manifest',
    label: 'Update catalog',
    group: 'storage',
    type: 'path',
    default: null,
    help: 'Which versions are offered to which robots.',
  },

  /* ── Software (server) ──────────────────────────────────────────────── */
  {
    key: 'PHOENIX_NLU_RUNTIME',
    label: 'Grammar runtime',
    group: 'software',
    type: 'string',
    default: 'ast',
    help: 'Which implementation runs Jibo’s grammars. compiled-fst needs an installed snapshot.',
  },
  {
    key: 'ETCO_server_asrProvider',
    label: 'Legacy speech test provider',
    group: 'software',
    type: 'string',
    default: 'parakeet',
    help: 'Original archive compatibility seam. Keep parakeet or unset for the Speech recognizer choice above; '
      + 'google here selects the legacy mock recognizer, not the new Cloud Speech-to-Text backend.',
  },
  {
    key: 'PHOENIX_BRANDING_FILE',
    label: 'Branding',
    group: 'software',
    type: 'path',
    default: null,
    help: 'Wording and design merged over the shipped site.',
  },
  {
    key: 'PHOENIX_PAGES_DIR',
    label: 'Custom pages',
    group: 'software',
    type: 'path',
    default: null,
    help: 'Pages served in place of the built-in landing, guide and legal pages.',
  },
  {
    key: 'PHOENIX_ASR_CAPTURE_DIR',
    label: 'Audio capture',
    group: 'software',
    type: 'path',
    default: null,
    help: 'When set, recordings are written here for debugging. It records people in the room.',
  },
];

/** Settings by key, for validation and lookup. */
export const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Keys the console may change. */
export const EDITABLE_KEYS = new Set(SETTINGS.filter((s) => s.editable).map((s) => s.key));

export const isEditable = (key) => EDITABLE_KEYS.has(key);
export const isSecret = (key) => BY_KEY.get(key)?.type === 'secret';

const HOST = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/**
 * Validate one value against its declared type. An empty value always passes:
 * it means "not set here", so the server's own value or the default applies.
 * @returns {string|null} what is wrong, or null when the value is acceptable
 */
export function validate(key, value) {
  const spec = BY_KEY.get(key);
  if (!spec) return 'is not a setting this server knows';
  const v = String(value ?? '');
  if (v.trim() === '') return null;
  if (/[\0\r\n]/.test(v)) return 'must be on one line';
  if (v.length > 2048) return 'is too long';
  if (v !== v.trim()) return 'must not start or end with a space';

  switch (spec.type) {
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return 'must be a number';
      const n = Number(v);
      if (spec.integer && !Number.isInteger(n)) return 'must be a whole number';
      if (spec.min != null && n < spec.min) return `must be at least ${spec.min.toLocaleString('en-US')}`;
      if (spec.max != null && n > spec.max) return `must be at most ${spec.max.toLocaleString('en-US')}`;
      return null;
    }
    case 'bool':
      return /^(true|false)$/.test(v) ? null : 'must be on or off';
    case 'url': {
      if (/\s/.test(v)) return 'must not contain spaces';
      if (!/^https?:\/\//i.test(v)) return 'must start with http:// or https://';
      try {
        const url = new URL(v);
        return url.hostname ? null : 'needs a host name';
      } catch {
        return 'is not a valid web address';
      }
    }
    case 'host':
      return HOST.test(v) || IPV4.test(v) ? null : 'must be a host name like smtp.example.com';
    case 'email':
      return EMAIL.test(v) ? null : 'must be an email address like phoenix@example.com';
    case 'enum': {
      const allowed = (spec.options || []).map((o) => o.value);
      return allowed.includes(v) ? null : 'is not one of the choices';
    }
    default:
      return null;
  }
}

/**
 * Problems that only show when settings are read together. `values` is every
 * setting as the services would see it after a restart: saved here, else the
 * server's, else unset. Errors block a save; warnings are shown beside it.
 * @returns {{errors: Record<string,string>, warnings: Array<{key:string, message:string}>}}
 */
export function checkTogether(values) {
  const errors = {};
  const warnings = [];
  const has = (key) => String(values[key] ?? '').trim() !== '';
  if (['auto', 'google'].includes(values.PHOENIX_ASR_PROVIDER)) {
    if (!has('PHOENIX_GOOGLE_STT_PROJECT')
      || (!has('PHOENIX_GOOGLE_STT_CREDENTIALS_FILE') && !has('GOOGLE_APPLICATION_CREDENTIALS'))) {
      warnings.push({ key: 'PHOENIX_ASR_PROVIDER', message: 'Google needs a Cloud project and a credentials file installed on the server. It stays off until both are configured.' });
    }
    if (values.PHOENIX_GOOGLE_STT_MONTHLY_MINUTES === '0') {
      warnings.push({ key: 'PHOENIX_GOOGLE_STT_MONTHLY_MINUTES', message: 'The monthly limit is zero, so Google is disabled.' });
    }
    if (values.ETCO_server_asrProvider === 'google') {
      warnings.push({ key: 'PHOENIX_ASR_PROVIDER', message: 'The legacy Google mock provider takes precedence. Remove that server setting before using Cloud Speech-to-Text.' });
    }
  }
  const speechModel = values.PHOENIX_GOOGLE_STT_MODEL || 'chirp_3';
  const speechLocation = values.PHOENIX_GOOGLE_STT_LOCATION || 'us';
  const speechLocations = speechModel === 'chirp_2' ? ['us-central1', 'europe-west4', 'asia-southeast1'] : ['us', 'eu'];
  if (['auto', 'google'].includes(values.PHOENIX_ASR_PROVIDER) && !speechLocations.includes(speechLocation)) {
    errors.PHOENIX_GOOGLE_STT_LOCATION = 'choose a location supported by the selected Google model';
  }
  if (values.PHOENIX_NEWS_BRIEFINGS_ENABLED === 'true' && !has('WORLD_NEWS_API_KEY')) {
    warnings.push({ key: 'WORLD_NEWS_API_KEY', message: 'News briefings need a World News key. Jibo will use the basic feed until one is added.' });
  }

  // The account service refuses to start when SMTP is half-configured without a
  // host (smtpMail.js smtpConfigFromEnv). Saving that would lock everyone out of
  // the console, so it is not allowed.
  const smtpFields = ['ETCO_account_mailSmtpPort', 'ETCO_account_mailSmtpSecure', 'ETCO_account_mailSmtpUser',
    'ETCO_account_mailSmtpPassword', 'ETCO_account_mailSmtpRequireTLS'];
  if (!has('ETCO_account_mailSmtpHost') && smtpFields.some(has)) {
    errors.ETCO_account_mailSmtpHost = 'is needed once any other mail server setting is set';
  }

  if (values.ETCO_parser_decisionEngine === 'jev' && !has('ETCO_parser_decisionApiKey') && !has('OPENROUTER_API_KEY')) {
    warnings.push({ key: 'ETCO_parser_decisionApiKey',
      message: 'The decision layer is on but has no key, so it stays off.' });
  }
  if (values.ETCO_parser_layaEnabled === 'true' && (!has('ETCO_parser_layaUrl') || !has('ETCO_parser_layaToken'))) {
    warnings.push({ key: 'ETCO_parser_layaEnabled',
      message: 'Laya is on but needs both an address and a token.' });
  }
  if (values.PHOENIX_GQA_DEFAULT_PROFILE === 'phoenix-answer' && !has('LLM_URL')) {
    warnings.push({ key: 'PHOENIX_GQA_DEFAULT_PROFILE',
      message: 'Answers is set to ask a language model, but no endpoint is set.' });
  }
  if (values.ETCO_parser_layaSecondaryFallback === 'llm' && !has('LLM_URL')) {
    warnings.push({ key: 'ETCO_parser_layaSecondaryFallback',
      message: 'This asks a language model, but no endpoint is set.' });
  }
  return { errors, warnings };
}

/** Every service that must restart for this set of changed keys. */
export function servicesFor(keys) {
  const out = new Set();
  for (const key of keys) for (const s of BY_KEY.get(key)?.restart || []) out.add(s);
  return SERVICE_IDS.filter((id) => out.has(id));
}
