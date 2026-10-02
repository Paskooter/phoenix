// Original report news filters, shared by the legacy parser and briefing producer.
export const NEWS_ADULT_KEYWORDS = new Set([
  'attack', 'attacks', 'attacked', 'attacking', 'arrest', 'arrested', 'assault', 'assaulted',
  'bomb', 'bombed', 'bombing', 'dead', 'deadly', 'death', 'die', 'died', 'dying', 'gun', 'guns',
  'kill', 'killed', 'killing', 'murder', 'murdered', 'weapon', 'weapons', 'rape', 'raped', 'shot',
  'shooting', 'stabbed', 'stabbing', 'sex', 'sexual', 'sexy',
]);
// The reference ships a large profanity list; vendored intact from NewsParse.ts.
export const NEWS_BANNED_KEYWORDS = new Set([
    "4r5e", "5h1t", "5hit", "a55", "ar5e", "arrse", "arse", "ass-fucker", "assfucker", "assfukka",
    "asshole", "assholes", "asswhole", "a_s_s", "b!tch", "b00bs", "b17ch", "b1tch", "ballbag",
    "ballsack", "beastiality", "bellend", "bestiality", "bi\\+ch", "biatch", "bitcher", "bitchers",
    "bitchin", "bitching", "blow job", "blowjob", "blowjobs", "boiolas", "bollock", "bollok", "boner",
    "booobs", "boooobs", "booooobs", "booooooobs", "buceta", "bugger", "bunny fucker", "butthole", "buttmuch",
    "buttplug", "c0ck", "c0cksucker", "carpet muncher", "cawk", "cipa", "cl1t", "clit", "clits", "cnut",
    "cock-sucker", "cockface", "cockhead", "cockmunch", "cockmuncher", "cocksuck", "cocksucked", "cocksucker",
    "cocksucking", "cocksucks", "cocksuka", "cocksukka", "cok", "cokmuncher", "coksucka", "coon", "cox", "cum",
    "cummer", "cumming", "cums", "cumshot", "cunilingus", "cunillingus", "cunnilingus", "cunt", "cuntlick",
    "cuntlicker", "cuntlicking", "cunts", "cyberfuc", "cyberfuck", "cyberfucked", "cyberfucker", "cyberfuckers",
    "cyberfucking", "d1ck", "dickhead", "dildo", "dildos", "dinks", "dirsa", "dlck", "dog-fucker", "doggin", "dogging",
    "donkeyribber", "doosh", "duche", "ejakulate", "f u c k", "f u c k e r", "f4nny", "fag", "fagging", "faggitt",
    "faggot", "faggs", "fagot", "fagots", "fags", "fannyflaps", "fannyfucker", "fanyy", "fatass", "fcuk", "fcuker",
    "fcuking", "feck", "fecker", "felching", "fellate", "fellatio", "fingerfuck", "fingerfucked", "fingerfucker",
    "fingerfuckers", "fingerfucking", "fingerfucks", "fistfuck", "fistfucked", "fistfucker", "fistfuckers",
    "fistfucking", "fistfuckings", "fistfucks", "flange", "fook", "fooker", "fuck", "fucka", "fucked", "fucker",
    "fuckers", "fuckhead", "fuckheads", "fuckin", "fucking", "fuckings", "fuckingshitmotherfucker", "fuckme",
    "fucks", "fuckwhit", "fuckwit", "fudge packer", "fudgepacker", "fuk", "fuker", "fukker", "fukkin", "fuks",
    "fukwhit", "fukwit", "fux", "fux0r", "f_u_c_k", "gangbang", "gangbanged", "gangbangs", "gaylord", "gaysex",
    "goatse", "god-dam", "god-damned", "goddamn", "goddamned", "hardcoresex", "heshe", "hoar", "hoare", "hoer",
    "hore", "hotsex", "jack-off", "jackoff", "jap", "jerk-off", "jism", "jiz", "jizm", "jizz", "kawk", "knobead",
    "knobed", "knobend", "knobhead", "knobjocky", "knobjokey", "kock", "kondum", "kondums", "kum", "kummer",
    "kumming", "kums", "kunilingus", "l3i\\+ch", "l3itch", "m0f0", "m0fo", "m45terbate", "ma5terb8", "ma5terbate",
    "master-bate", "masterb8", "masterbat*", "masterbat3", "masterbate", "masterbation", "masterbations",
    "masturbate", "mo-fo", "mof0", "mofo", "mothafuck", "mothafucka", "mothafuckas", "mothafuckaz", "mothafucked",
    "mothafucker", "mothafuckers", "mothafuckin", "mothafucking", "mothafuckings", "mothafucks", "mother fucker",
    "motherfuck", "motherfucked", "motherfucker", "motherfuckers", "motherfuckin", "motherfucking", "motherfuckings",
    "motherfuckka", "motherfucks", "muff", "mutha", "muthafecker", "muthafuckker", "mutherfucker", "n1gga", "n1gger",
    "nigg3r", "nigg4h", "nigga", "niggah", "niggas", "niggaz", "nigger", "niggers", "nob jokey", "nobhead", "nobjocky",
    "nobjokey", "numbnuts", "nutsack", "p0rn", "pecker", "penisfucker", "phonesex", "phuck", "phuk", "phuked", "phuking",
    "phukked", "phukking", "phuks", "phuq", "pigfucker", "pimpis", "pisser", "pissers", "pisses", "pissflaps", "pissin",
    "pissing", "pissoff", "pron", "pube", "pusse", "pussi", "pussies", "pussys", "rimjaw", "rimming", "schlong", "scroat",
    "scrote", "scrotum", "sh!\\+", "sh!t", "sh1t", "shagger", "shaggin", "shagging", "shemale", "shi\\+", "shit", "shitdick",
    "shite", "shited", "shitey", "shitfuck", "shitfull", "shithead", "shiting", "shitings", "shits", "shitted", "shitter",
    "shitters", "shitting", "shittings", "shitty", "skank", "slut", "sluts", "smegma", "son-of-a-bitch", "s_h_i_t", "t1tt1e5",
    "t1tties", "teez", "titfuck", "tits", "titt", "tittie5", "tittiefucker", "titties", "tittyfuck", "tittywank", "titwank",
    "tw4t", "twat", "twathead", "twatty", "twunt", "twunter", "v14gra", "v1gra", "w00se", "wank", "wanker", "wanky", "whoar", "whore"
]);

/** Classify original source text as well as generated speech; shortening must not bypass filters. */
export function classifyNewsContent(text) {
  const words = new Set(String(text).toLowerCase().match(/\w+/g));
  return {
    banned: [...NEWS_BANNED_KEYWORDS].some(word => words.has(word)),
    adult: [...NEWS_ADULT_KEYWORDS].some(word => words.has(word)),
  };
}
