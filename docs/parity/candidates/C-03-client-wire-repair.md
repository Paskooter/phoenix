# C-03 report client wire repair

Status: bounded candidate awaiting root review. The preceding `c03-main-review` worktree is
unchanged.

This candidate starts from `931ed0eed6b933c530c5166dc5d8588fee8718a6` in the fresh worktree
`/home/shell/work/phoenix/.parity/worktrees/c03-client-wire-repair`. Source review found that
Pegasus `BaseService` creates `req.jibo = new JiboHeaders(req.headers)` before the skill route,
and `BaseSkill` passes that request into the skill handler. Phoenix's common route already
provided the incoming `req` to its route middleware, but `skillRoute` discarded it and
`GraphSkill` omitted it from report data. The repair keeps that context inside the skills
boundary and allowlists only the three source Jibo trace headers; authentication and unrelated
caller headers are never copied to Lasso.

`sourceJiboHeaders()` now matches the pinned `JiboHeaders` defaults and mutable `toHeader()`:
`x-jibo-transid=unknown`, `x-jibo-robotid=unknown`, and `x-jibo-logging-config={}` when absent.
The real HTTP report service path was tested with incoming Jibo headers plus an Authorization
header. Both DarkSky calls forwarded the three Jibo headers and dropped Authorization.

All report Lasso methods now pass `data.req.jibo.toHeader()` to GET/HEAD requests, and Settings
uses the source `application/json;charset=utf-8` content type. The original Node 8.9.4 clients
and candidate clients ran against equivalent local recording peers. Decoded DarkSky and Settings
values, URL paths, bodies, and semantic Jibo/settings headers matched. The only remaining
recorded wire difference is the runtime-generated User-Agent: original Axios reports
`axios/0.17.1`; Node 22 fetch reports `node`. It is retained as runtime provenance rather than
spoofed.

Source pins are reference revision `5c0a7390539663ba749d360de348a428c088505c`; the relevant
compiled `JiboHeaders`, `BaseService`, `BaseSkill`, report Lasso, and Settings files are listed
in the JSON report. The source/candidate peer receipt is
`.parity/reviews/c03-client-wire-repair/client-comparison.json`.

After `npm ci --ignore-scripts --offline`, the complete skills suite passed 106/106. The
workspace resolution receipt is `.parity/reviews/c03-client-wire-repair/candidate-runtime-resolution.json`.
No main, shared common HTTP, live service, robot, or provider changes were made. Full C-03
parity and any runtime-specific User-Agent contract remain open for root acceptance.
