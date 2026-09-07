# Q-01 Wikipedia provider and service profile — root acceptance

Status: **accepted bounded implementation; whole Q-01 remains open**.

Runtime `76ba31bd3765b9ab05ed859609439f42013332d0` integrates the unique Wikipedia candidate commits onto current main and preserves the existing GQA, chitchat and prompt repairs. [Root evidence](../evidence/2026-09-07/gqa-wikipedia/review.json) records **34/34 complete response and recovery comparisons**, **40/40 ordered provider requests**, and **68 actual original Hub client HTTP exchanges**.

Source-guided extensions found nine substantive differences before root correction: usable page data on non-200 responses, a top-level diagnostic accompanying usable data, normal and normalized redirect reloads, invalid redirect rejection, empty pageprops disambiguation, case-sensitive option exclusions, missing page URL handling, and the default provider deadline. The baseline matched 25/34; the corrected runtime matches 34/34. A 3.4-second provider response now produces the source no-answer action at about 3.002 seconds, and the next request succeeds.

The controls execute the actual recovered GQA route/orchestration with Wikipedia 1.4.0, requests, BeautifulSoup and NLTK 3.2.5 against identical controlled HTTP bytes. Source route serialization uses Flask 0.12.2 test_client. Python 3.6.15, the MarkupSafe 1.1.1 fallback, inferred six 1.10.0 and the selected model/stopwords are explicitly qualified; the historical asset versions were not pinned. Account/attribution and other providers remain named seams.

The comparison retains speech, display, nulls, action structure, analytics, status and timing keys. Generated IDs must have valid shapes and a unique bijection across responses. Only measured timing values and the named missing-transID 400 diagnostic wording are qualified. Original Node 8.9.4 SkillRequestMaker/Axios 0.17.1 consumes every raw response: successful text/html and application/json bodies both become the expected complete objects, and the diagnostic difference preserves the client error. All 23 negative comparator mutations are rejected, including speech changes and reused IDs.

Validation: **672 units passed, 5 skipped, 0 failed**; the strict 43-case default production smoke has zero differences, invariants or gaps. All 5 final review commands exited 0 with the 5194 tracked product files, 454 source/dependency files, 11 control files and own workspace links stable. Earlier failed baselines and flawed comparison receipts are retained separately.

Use the explicit `PHOENIX_GQA_PROFILE=wikipedia` service profile and `ETCO_gqa_wikiApi` to select the endpoint; the original route is `/answer_skill/v1/main`. This review does not activate the profile in normal deployment. Live providers, other answer services, account/attribution, full production answer coverage and robot verification remain open. Checklist completion remains 8/79 (10.1%).
