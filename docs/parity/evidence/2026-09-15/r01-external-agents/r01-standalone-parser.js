// R-01 control: run the ORIGINAL parser as its own process.
//
// The two "Listen with external agents" cases assert dialogflowRequest.isDone(),
// i.e. that the parser's own outbound POST to api.api.ai was intercepted by
// nock. nock patches http inside ONE process. In the all-original baseline the
// parser is constructed in the test's own process
// (integration-tests-int/src/utils/integration.ts:30), so that works.
//
// This starts the same original ParserService in a separate process, changing
// nothing else. If those two cases then fail, the cause is the process
// boundary, not whatever implementation is behind the URL.
const { ParserService, ParserConfigProvider } = require('@jibo/parser');

const port = Number(process.env.R01_PARSER_PORT || 9999);
const service = new ParserService(ParserConfigProvider.getConfig());
service.init(port).then(
  () => { console.log(JSON.stringify({ ready: true, port })); },
  (err) => { console.error('parser failed:', err && err.message); console.error(JSON.stringify(err && (err.errors || err), null, 1).slice(0, 2000)); process.exit(1); },
);
