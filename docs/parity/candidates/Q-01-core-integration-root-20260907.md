# Q-01 core integration root review

Root accepted the bounded GQA factory and HTTP adapter at `ef4c758073ad82ef6d7d1c9da134e203aea1225d`. It preserves original response/MIM construction, speech/display actions, provider timing keys, request validation and HTTP error statuses. The shared HTTP service selects loose JSON parsing only for a route that requests it, allowing GQA to apply the original primitive-body failure behavior.

The final candidate matches all 20 complete original HTTP status/body controls, with validated generated identifiers and elapsed values normalized. Original blocked-term controls match 473/473. Root additionally found and repaired 29 differences in 193 original question-cleaning and request-filter controls; these changed provider input or whether providers were called. Missing question phrases and JavaScript's ASCII word/digit classes caused those differences.

The 20 original HTTP expectations run recovered Python 3.6.15/Flask 0.12.2 with the documented MarkupSafe 1.1.1 fallback. Python 3.6 is a compatible recovered runtime, not proof of the historical production version. The new NLP controls use the actual original module on Python 3.10.12. Provider/account/attribution seams and the earlier invalid source-control attempts remain explicitly qualified in the [review](../evidence/2026-09-07/gqa-core/review.json). Diagnostic wording differences remain nonblocking unless client interpretation changes.

The frozen integrated tree passes 614 unit tests (three skipped) and all 43 strict smoke cases, with zero differences or coverage gaps. Local workspace links were verified before and after capture. The earlier primitive-body test failure was caused by another checkout's shared HTTP module and is retained as rejected test evidence.

This acceptance covers the explicit factory and adapter. It does not switch the default answer service or accept the separate Wikipedia/provider/profile candidates. Full Q-01, account/attribution and real-robot GQA acceptance remain open.
