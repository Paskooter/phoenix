// The settings catalogue behind the admin console's Configuration surface.
//
// Every entry describes one environment variable that an operator may reasonably
// want to change: what it is, what it defaults to, which services read it, and
// what has to happen before a change takes effect.
//
// Two things this file is deliberately careful about.
//
// 1. **Nothing here is applied live.** Services resolve these at startup, so a
//    change written to .env takes effect when the services that read it are next
//    restarted. Each entry names those services and the console says so plainly
//    rather than implying the value is already in force.
//
// 2. **Defaults are the real ones or absent.** Where the default is stated it was
//    read out of the code that consumes the variable. Where the behaviour is
//    "unset means the launcher decides" the default is null and the console shows
//    "not set" rather than inventing a value.
//
// Adding a setting: append it to the group it belongs to. The console needs no
// change — it renders whatever this file declares.

/** Service identifiers, used for "what to restart" and for grouping. */
export const SERVICES = {
  account: { label: 'Account', compose: 'account', script: 'packages/account/src/index.js' },
  gateway: { label: 'Gateway / hub', compose: 'hub', script: 'packages/gateway/src/index.js' },
  classic: { label: 'Classic', compose: 'classic', script: 'packages/classic/src/index.js' },
  nlu: { label: 'NLU / parser', compose: 'parser', script: 'packages/nlu/src/index.js' },
  skills: { label: 'Skills', compose: 'answer-skill', script: 'packages/skills/src/index.js' },
  data: { label: 'Data / lasso', compose: 'lasso', script: 'packages/data/src/index.js' },
  history: { label: 'History', compose: 'history', script: 'packages/history/src/index.js' },
  ota: { label: 'OTA', compose: 'ota', script: 'packages/ota/src/index.js' },
};

export const GROUPS = [
  {
    id: 'portal',
    label: 'Portal and account',
    blurb: 'The console you are reading, the account store behind it, and how robots are identified.',
    icon: 'user',
  },
  {
    id: 'auth',
    label: 'Authentication',
    blurb: 'How robots prove who they are. Getting these wrong is how a robot stops connecting.',
    icon: 'lock',
  },
  {
    id: 'speech',
    label: 'Speech recognition',
    blurb: 'Where audio from the robot is turned into text.',
    icon: 'mic',
  },
  {
    id: 'llm',
    label: 'Language model',
    blurb: 'The optional OpenAI-compatible endpoint used by the answer skill and as a parser fallback.',
    icon: 'sparkle',
  },
  {
    id: 'nlu',
    label: 'NLU runtime',
    blurb: 'Which parser implementation runs. The AST runtime is the default and needs no configuration.',
    icon: 'chip',
  },
  {
    id: 'report',
    label: 'Personal report',
    blurb: 'Weather, news, commute and calendar — the data behind what the robot reads out.',
    icon: 'sliders',
  },
  {
    id: 'classic',
    label: 'Classic services',
    blurb: 'Where the Classic entrypoint keeps its state, and how long it waits on upstreams.',
    icon: 'server',
  },
  {
    id: 'ota',
    label: 'Software updates',
    blurb: 'The update server that serves subsystem packages to robots.',
    icon: 'download',
  },
  {
    id: 'discovery',
    label: 'Service discovery',
    blurb: 'Where each service finds the others. The bundled launchers set these; override only to split hosts.',
    icon: 'link',
  },
  {
    id: 'logging',
    label: 'Logging',
    blurb: 'How much the services write, and how often they sample.',
    icon: 'inbox',
  },
];

/**
 * @typedef {object} Setting
 * @property {string}   key       the environment variable name
 * @property {string}   label     short human name
 * @property {string}   group     one of GROUPS[].id
 * @property {string}   type      string|secret|bool|number|url|path|enum
 * @property {string?}  default   the real default, or null when unset means "launcher decides"
 * @property {string}   help      what it does and what happens if you change it
 * @property {string[]} services  which services must restart for a change to apply
 * @property {boolean} [danger]   true when a wrong value breaks robot connectivity
 * @property {Array}   [options]  for type 'enum'
 * @property {string}  [placeholder]
 * @property {number}  [min] @property {number} [max]
 */

/** @type {Setting[]} */
export const SETTINGS = [
  /* ── Portal and account ────────────────────────────────────────────────── */
  {
    key: 'PORT',
    label: 'Account service port',
    group: 'portal',
    type: 'number',
    default: '7016',
    min: 1,
    max: 65535,
    services: ['account'],
    help: 'The port this console and the account API listen on. Behind a reverse proxy this is the '
      + 'port nginx proxies to, not the one people visit.',
  },
  {
    key: 'ETCO_account_region',
    label: 'Robot region',
    group: 'portal',
    type: 'string',
    default: 'api',
    danger: true,
    services: ['account'],
    help: 'Written into an adopted robot’s credentials.json. The robot builds <region>.jibo.com and '
      + '<region>-socket.jibo.com from it, and the serving certificate must cover the same region '
      + '(PHOENIX_TLS_REGIONS). Change these together or the robot rejects the server. "api" is what a '
      + 'physical Jibo reports.',
  },
  {
    key: 'ETCO_account_dataFile',
    label: 'Account store file',
    group: 'portal',
    type: 'path',
    default: 'packages/account/data/store.json',
    danger: true,
    services: ['account'],
    help: 'Where accounts, households, robots, tokens and sessions persist. Pointing this at a new path '
      + 'starts from an empty store — every account and paired robot appears to vanish until it is '
      + 'pointed back.',
  },
  {
    key: 'ETCO_account_secureCookies',
    label: 'Secure session cookies',
    group: 'portal',
    type: 'bool',
    default: 'false',
    services: ['account'],
    help: 'Marks the session cookie Secure, so browsers only send it over HTTPS. Turn this on once the '
      + 'console is served over TLS. Turning it on while serving over plain HTTP makes sign-in fail.',
  },
  {
    key: 'ETCO_account_portalUrl',
    label: 'Portal public URL',
    group: 'portal',
    type: 'url',
    default: null,
    services: ['account'],
    help: 'The externally reachable address of this console, used in invitation links. Leave unset to '
      + 'derive it from the request.',
  },
  {
    key: 'PHOENIX_BRANDING_FILE',
    label: 'Branding override file',
    group: 'portal',
    type: 'path',
    default: null,
    services: ['account'],
    help: 'A JSON file whose keys are merged over portal/branding.json — the product name, logo, accent '
      + 'colour and every string on the public site. Leave unset to use the shipped defaults.',
  },
  {
    key: 'PHOTO_PUBLIC_URL',
    label: 'Member photo public URL',
    group: 'portal',
    type: 'url',
    default: null,
    services: ['account', 'classic'],
    help: 'The externally reachable origin that forwards GET /member-photos/:key. Must be an address the '
      + 'robot can actually reach — not account:8080, not localhost.',
  },
  {
    key: 'PHOTO_DIRECTORY',
    label: 'Member photo directory',
    group: 'portal',
    type: 'path',
    default: 'packages/account/data/member-photos',
    services: ['account'],
    help: 'Where member photos are stored on disk.',
  },
  {
    key: 'ETCO_account_mailFrom',
    label: 'Invitation sender address',
    group: 'portal',
    type: 'string',
    default: null,
    placeholder: 'phoenix@example.com',
    services: ['account'],
    help: 'The From address on household invitation emails. Unset means invitations are not emailed.',
  },
  {
    key: 'ETCO_account_smsUrl',
    label: 'SMS gateway URL',
    group: 'portal',
    type: 'url',
    default: null,
    services: ['account'],
    help: 'Optional endpoint for sending invitations by text message. Unset disables SMS invitations.',
  },
  {
    key: 'ETCO_account_smsTimeoutMs',
    label: 'SMS timeout (ms)',
    group: 'portal',
    type: 'number',
    default: null,
    min: 100,
    max: 120000,
    services: ['account'],
    help: 'How long to wait on the SMS gateway before giving up.',
  },

  /* ── Authentication ────────────────────────────────────────────────────── */
  {
    key: 'HUB_TOKEN_SECRET',
    label: 'Hub token secret',
    group: 'auth',
    type: 'secret',
    default: 'dev-hub-token-secret',
    danger: true,
    services: ['gateway', 'account'],
    help: 'Signs and verifies the short-lived tokens robots use to reach the hub. Change it for any '
      + 'deployment that is not a private LAN. Changing it invalidates every token already issued, so '
      + 'robots reconnect. The gateway and the account service must agree — restart both together.',
  },
  {
    key: 'DISABLE_AUTH',
    label: 'Accept unauthenticated robots',
    group: 'auth',
    type: 'bool',
    default: 'false',
    danger: true,
    services: ['gateway'],
    help: 'When true the hub accepts robots without verifying a token. This is a LAN convenience for '
      + 'bring-up only: with it on, anything that can reach the port can talk to your household. Set it '
      + 'false for any real deployment.',
  },
  {
    key: 'WEB_TOKEN_SECRET',
    label: 'Web token secret',
    group: 'auth',
    type: 'secret',
    default: null,
    danger: true,
    services: ['gateway', 'account'],
    help: 'Signs tokens issued to web clients. Leave unset unless you are running the web client path.',
  },
  {
    key: 'ETCO_hub_accountUrl',
    label: 'Hub → account verify URL',
    group: 'auth',
    type: 'url',
    default: null,
    services: ['gateway'],
    help: 'When set (and unauthenticated robots are disabled) the hub checks each token’s accessKeyId '
      + 'against the account service, so deactivating a robot revokes it immediately. The bundled '
      + 'launchers wire this automatically; set it only when running the hub standalone.',
  },
  {
    key: 'ETCO_hub_accountVerifyTimeoutMs',
    label: 'Account verify timeout (ms)',
    group: 'auth',
    type: 'number',
    default: '5000',
    min: 100,
    max: 60000,
    services: ['gateway'],
    help: 'Bounds the whole verification response, body included. Too low and robots fail to connect '
      + 'under load; too high and a dead account service stalls every connection attempt.',
  },
  {
    key: 'PHOENIX_TLS_REGIONS',
    label: 'TLS certificate regions',
    group: 'auth',
    type: 'string',
    default: 'api',
    danger: true,
    services: ['account', 'classic'],
    help: 'Which <region>.jibo.com names the serving certificate is issued for. Must cover the robot '
      + 'region above, or the robot rejects the connection.',
  },

  /* ── Speech recognition ────────────────────────────────────────────────── */
  {
    key: 'ETCO_server_asrProvider',
    label: 'Speech provider',
    group: 'speech',
    type: 'enum',
    default: null,
    options: [
      { value: '', label: 'Default (Parakeet)' },
      { value: 'google', label: 'Google Speech (mock address below)' },
    ],
    services: ['gateway'],
    help: 'Which recognition backend the hub streams audio to. Unset uses the Parakeet path.',
  },
  {
    key: 'PARAKEET_URL',
    label: 'Parakeet ASR URL',
    group: 'speech',
    type: 'url',
    default: null,
    placeholder: 'http://192.168.1.252:6972',
    services: ['gateway'],
    help: 'The Parakeet speech service (POST /transcribe). Unset means the launcher probes the real '
      + 'endpoint below and otherwise falls back to a mock, which transcribes nothing useful.',
  },
  {
    key: 'REAL_PARAKEET',
    label: 'Parakeet probe URL',
    group: 'speech',
    type: 'url',
    default: null,
    placeholder: 'http://192.168.1.252:6972',
    services: ['gateway'],
    help: 'Probed by the launchers when the URL above is unset: if it answers, it is used; if not, the '
      + 'mock is.',
  },
  {
    key: 'ETCO_server_parakeetUrl',
    label: 'Parakeet URL (ETCO form)',
    group: 'speech',
    type: 'url',
    default: null,
    services: ['gateway'],
    help: 'The source-shaped name for the same setting. Use whichever your launcher sets; do not set both '
      + 'to different values.',
  },
  {
    key: 'PHOENIX_ASR_SILENCE_EOS_MS',
    label: 'End-of-speech silence (ms)',
    group: 'speech',
    type: 'number',
    default: null,
    min: 100,
    max: 10000,
    services: ['gateway'],
    help: 'How long a pause ends an utterance. Lower cuts people off mid-sentence; higher makes the robot '
      + 'feel slow to answer.',
  },
  {
    key: 'PHOENIX_ASR_NOISE_MARGIN',
    label: 'Noise margin',
    group: 'speech',
    type: 'string',
    default: null,
    services: ['gateway'],
    help: 'How far above the measured noise floor audio must rise to count as speech. Raise it in a noisy '
      + 'room if the robot keeps waking to nothing.',
  },
  {
    key: 'PHOENIX_ASR_CAPTURE_DIR',
    label: 'Audio capture directory',
    group: 'speech',
    type: 'path',
    default: null,
    services: ['gateway'],
    help: 'When set, recognised audio is written here for debugging. This records people in the room — '
      + 'leave it unset unless you are actively diagnosing something, and clear it afterwards.',
  },
  {
    key: 'PHOENIX_FFMPEG',
    label: 'ffmpeg binary',
    group: 'speech',
    type: 'path',
    default: null,
    placeholder: 'ffmpeg',
    services: ['gateway'],
    help: 'Path to ffmpeg, used for audio conversion. Unset means whatever is on PATH.',
  },

  /* ── Language model ────────────────────────────────────────────────────── */
  {
    key: 'LLM_URL',
    label: 'LLM endpoint',
    group: 'llm',
    type: 'url',
    default: null,
    placeholder: 'http://192.168.1.252:1234/v1',
    services: ['skills', 'nlu'],
    help: 'An OpenAI-compatible endpoint (LM Studio, Ollama, vLLM …) used by the answer skill and as a '
      + 'parser fallback. Unset means the robot answers only from its own dialog library.',
  },
  {
    key: 'LLM_MODEL',
    label: 'LLM model',
    group: 'llm',
    type: 'string',
    default: null,
    placeholder: 'google/gemma-4-e4b',
    services: ['skills', 'nlu'],
    help: 'The model name to request from that endpoint.',
  },
  {
    key: 'REAL_LLM',
    label: 'LLM probe URL',
    group: 'llm',
    type: 'url',
    default: null,
    services: ['skills', 'nlu'],
    help: 'Probed by the launchers when the endpoint above is unset.',
  },
  {
    key: 'ETCO_answer_llmUrl',
    label: 'Answer-skill LLM URL',
    group: 'llm',
    type: 'url',
    default: null,
    services: ['skills'],
    help: 'Overrides the endpoint for the answer skill specifically.',
  },
  {
    key: 'ETCO_parser_llmEnabled',
    label: 'Parser LLM fallback',
    group: 'llm',
    type: 'bool',
    default: 'false',
    services: ['nlu'],
    help: 'Lets the parser fall back to the language model when the grammar does not match. Enabled '
      + 'automatically when an endpoint is configured; set it true to force it on.',
  },
  {
    key: 'PHOENIX_LLM_CATALOG',
    label: 'LLM catalogue file',
    group: 'llm',
    type: 'path',
    default: null,
    services: ['skills'],
    help: 'A JSON file describing available models, used to pick among several.',
  },

  /* ── NLU runtime ───────────────────────────────────────────────────────── */
  {
    key: 'PHOENIX_NLU_RUNTIME',
    label: 'Parser runtime',
    group: 'nlu',
    type: 'enum',
    default: 'ast',
    danger: true,
    options: [
      { value: '', label: 'AST (default)' },
      { value: 'compiled-fst', label: 'Compiled FST — requires an installed snapshot' },
    ],
    services: ['nlu'],
    help: 'The AST runtime is the default and needs nothing else set. Selecting compiled-fst without a '
      + 'successfully installed snapshot stops the parser from starting — install first, then switch.',
  },
  {
    key: 'PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST',
    label: 'Compiled snapshot manifest',
    group: 'nlu',
    type: 'path',
    default: null,
    placeholder: 'runtime/nlu-snapshot-v1/profile.json',
    services: ['nlu'],
    help: 'The profile.json of an installed snapshot bundle. Install with '
      + 'scripts/install-nlu-snapshot.mjs to a new versioned directory, then point this at it.',
  },
  {
    key: 'PHOENIX_NLU_SNAPSHOT_DIR',
    label: 'Compiled snapshot directory',
    group: 'nlu',
    type: 'path',
    default: null,
    placeholder: './runtime/nlu-snapshot-v1',
    services: ['nlu'],
    help: 'The host directory the compose overlay mounts. Used with docker-compose.nlu-snapshot.yml.',
  },
  {
    key: 'PHOENIX_NLU_COMPILED_FST',
    label: 'Compiled FST path',
    group: 'nlu',
    type: 'path',
    default: null,
    services: ['nlu'],
    help: 'An alternative compiled profile. Do not combine this with a snapshot manifest — choose one.',
  },
  {
    key: 'PHOENIX_NLU_COMPILED_FACTORY_DIR',
    label: 'Compiled factory directory',
    group: 'nlu',
    type: 'path',
    default: null,
    services: ['nlu'],
    help: 'Part of the non-snapshot compiled profile. Mutually exclusive with a snapshot manifest.',
  },
  {
    key: 'PHOENIX_NLU_COMPILED_RULES_DIR',
    label: 'Compiled rules directory',
    group: 'nlu',
    type: 'path',
    default: null,
    services: ['nlu'],
    help: 'Part of the non-snapshot compiled profile. Mutually exclusive with a snapshot manifest.',
  },

  /* ── Personal report ───────────────────────────────────────────────────── */
  {
    key: 'prefsFromConfig',
    label: 'Read prefs from config file',
    group: 'report',
    type: 'bool',
    default: 'false',
    services: ['skills'],
    help: 'Reads resources/report-prefsConfig.json instead of per-user settings, which is what enables '
      + 'the commute and calendar sections in a bare local run.',
  },
  {
    key: 'NET_settings',
    label: 'Settings service',
    group: 'report',
    type: 'string',
    default: 'settings.jibo.aws',
    services: ['skills'],
    help: 'Where the report skill fetches a speaker’s personal settings. The default is the original '
      + 'name, resolved inside the stack.',
  },
  {
    key: 'TOMTOM_API_KEY',
    label: 'TomTom API key',
    group: 'report',
    type: 'secret',
    default: null,
    services: ['data'],
    help: 'Traffic and travel-time data for the commute section. Without it the robot can still describe '
      + 'the route but not the delay.',
  },
  {
    key: 'ETCO_data_orsKey',
    label: 'OpenRouteService key',
    group: 'report',
    type: 'secret',
    default: null,
    services: ['data'],
    help: 'Routing provider key, used for directions where TomTom is not configured.',
  },
  {
    key: 'ETCO_data_calendarUpstreamUrl',
    label: 'Calendar upstream URL',
    group: 'report',
    type: 'url',
    default: null,
    services: ['data'],
    help: 'Where calendar events are fetched from. Unset means the calendar section has nothing to read.',
  },
  {
    key: 'ETCO_data_calendarUpstreamToken',
    label: 'Calendar upstream token',
    group: 'report',
    type: 'secret',
    default: null,
    services: ['data'],
    help: 'Bearer token for the calendar upstream.',
  },
  {
    key: 'ETCO_data_calendarFixtureDir',
    label: 'Calendar fixture directory',
    group: 'report',
    type: 'path',
    default: null,
    services: ['data'],
    help: 'Serves calendar events from files on disk instead of an upstream. Useful for testing the '
      + 'report without wiring a real calendar.',
  },
  {
    key: 'ETCO_data_oauthSecretsDir',
    label: 'OAuth secrets directory',
    group: 'report',
    type: 'path',
    default: null,
    services: ['data'],
    help: 'Where Google/Outlook client secrets are read from for calendar access.',
  },
  {
    key: 'ETCO_data_credentialsFile',
    label: 'Data credentials file',
    group: 'report',
    type: 'path',
    default: null,
    services: ['data'],
    help: 'Stored per-user upstream credentials for the data service.',
  },
  {
    key: 'ETCO_gqa_wikiApi',
    label: 'Wikipedia API endpoint',
    group: 'report',
    type: 'url',
    default: null,
    services: ['skills'],
    help: 'Where general-question answers are looked up. Unset uses the public Wikipedia endpoint.',
  },
  {
    key: 'ETCO_gqa_wikiTimeoutMs',
    label: 'Wikipedia timeout (ms)',
    group: 'report',
    type: 'number',
    default: null,
    min: 100,
    max: 60000,
    services: ['skills'],
    help: 'How long to wait on that lookup before the robot says it does not know.',
  },
  {
    key: 'ETCO_gqa_attributionFile',
    label: 'GQA attribution file',
    group: 'report',
    type: 'path',
    default: null,
    services: ['skills'],
    help: 'Where answer attributions persist. Give each Classic process its own path — the local '
      + 'snapshot store is single-writer.',
  },

  /* ── Classic services ──────────────────────────────────────────────────── */
  {
    key: 'ETCO_classic_upstreamTimeoutMS',
    label: 'Upstream timeout (ms)',
    group: 'classic',
    type: 'number',
    default: '10000',
    min: 100,
    max: 60000,
    services: ['classic'],
    help: 'How long the Classic entrypoint waits on a backend. Values above 60000 are clamped to it, and '
      + 'anything non-positive falls back to 10000.',
  },
  {
    key: 'ETCO_classic_publicUrl',
    label: 'Classic public URL',
    group: 'classic',
    type: 'url',
    default: null,
    services: ['classic'],
    help: 'The externally reachable origin for Classic, used when building URLs the robot will fetch.',
  },
  {
    key: 'ETCO_classic_mediaDir',
    label: 'Media directory',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where photographs the robot captures are stored. This is the household’s gallery — put it '
      + 'somewhere that gets backed up.',
  },
  {
    key: 'ETCO_classic_mediaBaseUrl',
    label: 'Media base URL',
    group: 'classic',
    type: 'url',
    default: null,
    services: ['classic'],
    help: 'The origin media URLs are built from.',
  },
  {
    key: 'ETCO_classic_notificationFile',
    label: 'Notification snapshot file',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where notification state persists. Choose a private, durable path for a real deployment.',
  },
  {
    key: 'ETCO_classic_jotFile',
    label: 'Jot message file',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where household messages persist.',
  },
  {
    key: 'ETCO_classic_personFile',
    label: 'Person catalogue file',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where the person catalogue — who the robot knows and what it has learned — persists.',
  },
  {
    key: 'ETCO_classic_pushFile',
    label: 'Push registration file',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where device push registrations persist.',
  },
  {
    key: 'ETCO_classic_voiceTrainingFile',
    label: 'Voice training file',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where voice enrolment records persist.',
  },
  {
    key: 'ETCO_classic_iftttFile',
    label: 'IFTTT state file',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where IFTTT identity and trigger rows persist.',
  },
  {
    key: 'ETCO_classic_backupDir',
    label: 'Backup directory',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where robot backups are written.',
  },
  {
    key: 'ETCO_classic_robotDir',
    label: 'Robot state directory',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where per-robot Classic state is kept.',
  },
  {
    key: 'ETCO_classic_logDir',
    label: 'Classic log directory',
    group: 'classic',
    type: 'path',
    default: null,
    services: ['classic'],
    help: 'Where Classic writes its logs.',
  },

  /* ── Software updates ──────────────────────────────────────────────────── */
  {
    key: 'OTA_PUBLIC_URL',
    label: 'OTA public URL',
    group: 'ota',
    type: 'url',
    default: null,
    danger: true,
    services: ['ota'],
    help: 'The externally reachable base URL a robot downloads update packages from. Unset derives it '
      + 'from the request Host, which is usually right behind a proxy and wrong behind NAT. A robot that '
      + 'cannot fetch the package fails the upgrade partway.',
  },
  {
    key: 'ETCO_ota_dataDir',
    label: 'OTA package directory',
    group: 'ota',
    type: 'path',
    default: 'packages/ota/data',
    services: ['ota'],
    help: 'Where the subsystem packages being served live.',
  },
  {
    key: 'ETCO_ota_manifest',
    label: 'OTA manifest',
    group: 'ota',
    type: 'path',
    default: 'packages/ota/manifest.json',
    services: ['ota'],
    help: 'The catalogue describing which versions are offered to which robots.',
  },

  /* ── Service discovery ─────────────────────────────────────────────────── */
  ...[
    ['NET_classic', 'Classic', 'classic', ['account']],
    ['NET_parser', 'Parser / NLU', 'parser', ['gateway']],
    ['NET_history', 'History', 'history', ['gateway']],
    ['NET_data', 'Data', 'lasso', ['skills']],
    ['NET_lasso', 'Lasso', 'lasso', ['skills']],
    ['NET_skills', 'Skills host', 'answer-skill', ['gateway']],
    ['NET_ota', 'OTA', 'ota', ['classic']],
    ['NET_account', 'Account', 'account', ['gateway', 'classic']],
    ['NET_hub', 'Hub', 'hub', ['skills']],
    ['NET_person', 'Person', 'classic', ['skills']],
    ['NET_robotread', 'Robot read', 'classic', ['skills']],
  ].map(([key, label, compose, services]) => ({
    key,
    label: `${label} address`,
    group: 'discovery',
    type: 'string',
    default: null,
    services,
    placeholder: `${compose}:8080`,
    help: `Where to reach the ${label} service — host:port, or a full URL. http:// is added when the `
      + 'scheme is missing. The bundled launchers set this; override it only to split services across '
      + 'hosts.',
  })),

  /* ── Logging ───────────────────────────────────────────────────────────── */
  {
    key: 'LOG_LEVEL',
    label: 'Log level',
    group: 'logging',
    type: 'enum',
    default: 'info',
    options: [
      { value: 'error', label: 'error — failures only' },
      { value: 'warn', label: 'warn — failures and warnings' },
      { value: 'info', label: 'info (default)' },
      { value: 'debug', label: 'debug — verbose, noisy' },
    ],
    services: Object.keys(SERVICES),
    help: 'How much every service writes. Debug is genuinely noisy and will fill a disk over weeks; use '
      + 'it while diagnosing, not as a standing setting.',
  },
  {
    key: 'ETCO_log_probability',
    label: 'Log sampling probability',
    group: 'logging',
    type: 'string',
    default: null,
    placeholder: '0.1',
    services: Object.keys(SERVICES),
    help: 'Samples high-volume log lines, between 0 and 1. Unset logs everything at the chosen level.',
  },
];

/** Settings by key, for validation and lookup. */
export const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Which secrets must never be sent to the browser unless explicitly revealed. */
export const isSecret = (key) => BY_KEY.get(key)?.type === 'secret';

/**
 * Validate one value against its declared type.
 * @returns {string|null} an error message, or null when the value is acceptable
 */
export function validate(key, value) {
  const spec = BY_KEY.get(key);
  if (!spec) return `${key} is not a known setting`;
  const v = String(value ?? '').trim();
  if (v === '') return null; // clearing a setting is always allowed: it returns to the default

  switch (spec.type) {
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return 'must be a number';
      const n = Number(v);
      if (spec.min != null && n < spec.min) return `must be at least ${spec.min}`;
      if (spec.max != null && n > spec.max) return `must be at most ${spec.max}`;
      return null;
    }
    case 'bool':
      return /^(true|false)$/i.test(v) ? null : 'must be true or false';
    case 'url':
      // host:port is accepted throughout this codebase; http:// is added when missing.
      if (/\s/.test(v)) return 'must not contain spaces';
      if (/^https?:\/\//.test(v)) {
        try { new URL(v); return null; } catch { return 'is not a valid URL'; }
      }
      return /^[A-Za-z0-9._-]+(:\d+)?(\/.*)?$/.test(v) ? null : 'must be a URL or host:port';
    case 'enum': {
      const allowed = (spec.options || []).map((o) => o.value);
      return allowed.includes(v) ? null : `must be one of: ${allowed.filter(Boolean).join(', ')}`;
    }
    case 'path':
      return /[\n\r\0]/.test(v) ? 'must not contain newlines' : null;
    default:
      return /[\n\r\0]/.test(v) ? 'must not contain newlines' : null;
  }
}

/** Every service that must restart for this set of changed keys. */
export function servicesFor(keys) {
  const out = new Set();
  for (const key of keys) for (const s of BY_KEY.get(key)?.services || []) out.add(s);
  return [...out];
}
