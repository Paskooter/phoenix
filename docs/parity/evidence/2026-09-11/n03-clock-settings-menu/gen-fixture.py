#!/usr/bin/env python3
"""Generate packages/nlu/test/fixtures/clock-settings-menu.json for N-03.

Expectations are derived from the pinned Pegasus rule sources
(pegasus@5c0a739:packages/parser/robust-parser/rules_src) and then confirmed at
runtime by the accompanying test.  Every case cites the source line(s) that
declare the arm it exercises.
"""
import json

REV = "5c0a7390539663ba749d360de348a428c088505c"
SRC = "pegasus:packages/parser/robust-parser/rules_src"

NULL = {"intent": None, "entities": None, "rules": []}


def E(intent, entities=None):
    return {"intent": intent, "entities": entities or {}, "rules": [None]}  # rules filled per rule


def case(kind, text, intent, cite, entities=None):
    return {"kind": kind, "text": text, "expect": {"intent": intent, "entities": entities or {}, "rules": []}, "source": cite}


def rule_row(rule, source, cases, neg):
    out = []
    for c in cases:
        c["expect"]["rules"] = [rule]
        out.append(c)
    nrows = []
    for text, cite in neg:
        nrows.append({"kind": "negative", "text": text, "expect": {"intent": None, "entities": None, "rules": []}, "source": cite})
    return {"rule": rule, "source": source, "cases": out + nrows}


F = "clock/alarm_timer_change.rule"
rows = []
rows.append(rule_row("clock/alarm_timer_change", F, [
    case("positive", "yes", "delete", f"{F}:7,12 (yes_no yes -> _intent yes -> cond delete)"),
    case("positive", "no", "keep", f"{F}:7,13 (yes_no no -> _intent no -> cond keep)"),
    case("boundary", "sure", "delete", f"{F}:20 ($YES arm yes|yup|sure|okay)"),
    case("boundary", "cancel it", "delete", f"{F}:22 ($YES arm $V_DELETE ?(it|that))"),
    case("boundary", "keep it", "keep", f"{F}:32 ($NO arm $V_KEEP ?(it|that))"),
], [("qzx florp", f"{F}:5-15 (no arm matches a nonsense token)"),
    ("banana", f"{F}:5-15 (no arm matches)")]))

F = "clock/alarm_timer_info.rule"
rows.append(rule_row("clock/alarm_timer_info", F, [
    case("positive", "change it", "change", f"{F}:12"),
    case("positive", "cancel it", "cancel", f"{F}:19"),
    case("boundary", "edit that", "change", f"{F}:12 (change|edit ?(it|that))"),
], [("qzx florp", f"{F}:5-8")]))

F = "clock/alarm_timer_none_set.rule"
rows.append(rule_row("clock/alarm_timer_none_set", F, [
    case("positive", "yes", "yes", f"{F}:8 ($factory:yes_no _nl)"),
    case("positive", "no", "no", f"{F}:8 ($factory:yes_no _nl)"),
    case("boundary", "sounds good", "yes", f"{F}:21 (YES_OTHER)"),
    case("boundary", "i think so", "yes", f"{F}:20 (YES_OTHER)"),
    case("boundary", "later", "no", f"{F}:27 (NO_OTHER)"),
    case("boundary", "not right now", "no", f"{F}:28 (NO_OTHER)"),
], [("qzx florp", f"{F}:6-11")]))

F = "clock/alarm_timer_okay.rule"
rows.append(rule_row("clock/alarm_timer_okay", F, [
    case("positive", "wrong", "wrong", f"{F}:7"),
    case("boundary", "wait", "wrong", f"{F}:7"),
    case("boundary", "stop", "wrong", f"{F}:7"),
    case("boundary", "no no", "wrong", f"{F}:7"),
    case("boundary", "not right", "wrong", f"{F}:7"),
    case("boundary", "cancel", "wrong", f"{F}:7"),
], [("qzx florp", f"{F}:5-9"),
    ("yes", f"{F}:5-9 (this rule has no positive/yes arm at all)")]))

F = "clock/alarm_timer_other_set.rule"
rows.append(rule_row("clock/alarm_timer_other_set", F, [
    case("positive", "yes", "replace", f"{F}:7,12 (yes_no yes -> cond replace)"),
    case("positive", "no", "keep", f"{F}:7,13 (yes_no no -> cond keep)"),
    case("boundary", "fine", "replace", f"{F}:24 ($YES arm fine)"),
    case("boundary", "cancel it", "replace", f"{F}:22 ($YES arm $V_REPLACE ?(it|that))"),
    case("boundary", "keep it", "keep", f"{F}:35 ($NO arm $V_KEEP ?(it|that))"),
], [("qzx florp", f"{F}:5-15")]))

F = "clock/alarm_timer_query_menu.rule"
rows.append(rule_row("clock/alarm_timer_query_menu", F, [
    case("positive", "change it", "change", f"{F}:12"),
    case("positive", "cancel that", "cancel", f"{F}:19"),
], [("qzx florp", f"{F}:5-8")]))

F = "clock/alarm_timer_too_long.rule"
rows.append(rule_row("clock/alarm_timer_too_long", F, [
    case("positive", "yes", "yes", f"{F}:16"),
    case("positive", "no", "no", f"{F}:30"),
    case("boundary", "sounds good", "yes", f"{F}:22 ($YES arm sounds good)"),
    case("boundary", "i'm good", "no", f"{F}:34 ($NO arm i'm good)"),
], [("qzx florp", f"{F}:5-11")]))

F = "clock/clock_menu.rule"
rows.append(rule_row("clock/clock_menu", F, [
    case("positive", "what time is it", "askForTime", f"{F}:15", {"domain": "clock"}),
    case("positive", "what is the date", "askForDate", f"{F}:16", {"domain": "clock"}),
    case("positive", "timer", "start", f"{F}:17", {"domain": "timer"}),
    case("positive", "alarm", "set", f"{F}:18", {"domain": "alarm"}),
    case("boundary", "show me the alarm", "set", f"{F}:10,18 (GENERIC_ACTION+THE+SUBSKILLS)", {"domain": "alarm"}),
    case("boundary", "the time", "askForTime", f"{F}:10,15", {"domain": "clock"}),
], [("qzx florp", f"{F}:13-20"),
    ("five", f"{F}:13-20 (no subskill noun)")]))

F = "clock/stop_timer.rule"
rows.append(rule_row("clock/stop_timer", F, [
    case("positive", "stop the timer", "stop", f"{F}:7"),
    case("boundary", "kill it", "stop", f"{F}:7 (kill)"),
    case("boundary", "end the timer", "stop", f"{F}:7 (end)"),
], [("qzx florp", f"{F}:3-5"),
    ("start the timer", f"{F}:7 (STOP has no start arm)")]))

F = "clock/timer_set_value.rule"
rows.append(rule_row("clock/timer_set_value", F, [
    case("positive", "set a timer for five minutes", "timerValue", f"{F}:31-39,44-45 (timer factory)",
         {"hours": "null", "minutes": "5", "seconds": "null", "domain": "timer"}),
    case("boundary", "set a timer for one hour", "timerValue", f"{F}:44-45 (timer factory)",
         {"hours": "1", "minutes": "null", "seconds": "null", "domain": "timer"}),
    case("boundary", "one day", "timerValue", f"{F}:51 (one|1 [day?s])",
         {"hours": "24", "minutes": "null", "seconds": "null", "domain": "timer"}),
    case("boundary", "a minute", "timerValue", f"{F}:55 (a|an [minute?s])",
         {"hours": "null", "minutes": "1", "seconds": "null", "domain": "timer"}),
    case("boundary", "a second", "timerValue", f"{F}:57 (a|an [second?s])",
         {"hours": "null", "minutes": "null", "seconds": "1", "domain": "timer"}),
    case("boundary", "set a timer for 3 days", "timerValue", f"{F}:48-49 (invalid timescale arm)",
         {"hours": "25", "minutes": "null", "seconds": "null", "domain": "timer"}),
    case("positive", "cancel the timer", "cancel", f"{F}:62 (D_TIMER_CANCEL)",
         {"hours": "null", "minutes": "null", "seconds": "null", "domain": "timer"}),
], [("qzx florp", f"{F}:29-63")]))

F = "settings/download_now_later.rule"
rows.append(rule_row("settings/download_now_later", F, [
    case("positive", "yes", "yes", f"{F}:5 (yes_no _nl)"),
    case("positive", "no thanks", "no", f"{F}:29 (NO_OTHER)"),
    case("boundary", "why not", "yes", f"{F}:19 (YES_OTHER)"),
    case("boundary", "not now", "no", f"{F}:38 (NO_OTHER)"),
    case("boundary", "cancel", "no", f"{F}:33 (NO_OTHER)"),
    case("positive", "never", "never", f"{F}:44 (NEVER)"),
], [("qzx florp", f"{F}:3-9")]))

F = "settings/execute_settings_menu.rule"
rows.append(rule_row("settings/execute_settings_menu", F, [
    case("positive", "battery", "battery", f"{F}:19"),
    case("positive", "shut down", "shutDown", f"{F}:20"),
    case("positive", "about", "about", f"{F}:21"),
    case("positive", "volume", "volumeQuery", f"{F}:22"),
    case("positive", "wifi", "wifiStatus", f"{F}:23"),
    case("positive", "updates", "updates", f"{F}:24"),
    case("positive", "wipe", "wipe", f"{F}:25"),
    case("boundary", "turn it off", "shutDown", f"{F}:20 ((turn $* off))"),
    case("boundary", "the battery", "battery", f"{F}:12,19 (?($THE) SETTINGSNAME)"),
], [("qzx florp", f"{F}:17-26")]))

F = "settings/okay_thanks_to_clear.rule"
rows.append(rule_row("settings/okay_thanks_to_clear", F, [
    case("positive", "okay thanks", "okayThanks", f"{F}:11 (okay)"),
    case("boundary", "got it", "okayThanks", f"{F}:14 (got it)"),
    case("boundary", "thank you", "okayThanks", f"{F}:13 (thank you)"),
    case("boundary", "thanks", "okayThanks", f"{F}:12 (thanks)"),
], [("qzx florp", f"{F}:9-16"),
    ("no", f"{F}:9-16 (no negative arm)")]))

F = "settings/shut_down_confirmation.rule"
rows.append(rule_row("settings/shut_down_confirmation", F, [
    case("positive", "yes", "yes", f"{F}:6 (yes_no _nl)"),
    case("positive", "no", "no", f"{F}:6 (yes_no _nl)"),
    case("boundary", "definitely", "yes", f"{F}:20 (YES)"),
    case("boundary", "certainly", "yes", f"{F}:19 (YES)"),
    case("boundary", "stay on", "no", f"{F}:38 (NO)"),
], [("qzx florp", f"{F}:5-8")]))

F = "settings/volume_control.rule"
rows.append(rule_row("settings/volume_control", F, [
    case("positive", "turn the volume up", "volumeUp", f"{F}:55-60", {"volumeLevel": "null", "domain": "gui_command"}),
    case("positive", "turn the volume down", "volumeDown", f"{F}:63-68", {"volumeLevel": "null", "domain": "gui_command"}),
    case("boundary", "what's your volume", "volumeQuery", f"{F}:38-39", {"volumeLevel": "null", "domain": "gui_command"}),
    case("boundary", "maximum volume", "volumeToValue", f"{F}:42-45", {"volumeLevel": "10", "domain": "gui_command"}),
    case("boundary", "minimum volume", "volumeToValue", f"{F}:49-52", {"volumeLevel": "01", "domain": "gui_command"}),
    case("boundary", "set the volume to five", "volumeToValue", f"{F}:74,84-91", {"volumeLevel": "05", "domain": "gui_command"}),
    case("boundary", "turn it up a bit", "volumeUp", f"{F}:55-56", {"volumeLevel": "null", "domain": "gui_command"}),
], [("qzx florp", f"{F}:11-33")]))

F = "main-menu/execute_fun_stuff.rule"
rows.append(rule_row("main-menu/execute_fun_stuff", F, [
    case("positive", "joke", "loadMenu", f"{F}:17", {"destination": "joke"}),
    case("positive", "dance", "loadMenu", f"{F}:18", {"destination": "dance"}),
    case("boundary", "tell me a joke", "loadMenu", f"{F}:10,17", {"destination": "joke"}),
    case("boundary", "surprise me", "loadMenu", f"{F}:19", {"destination": "surprise"}),
    case("boundary", "word of the day", "loadMenu", f"{F}:16", {"destination": "word-of-the-day"}),
    case("boundary", "circuit saver game", "loadMenu", f"{F}:15", {"destination": "circuit-saver"}),
], [("qzx florp", f"{F}:13-20")]))

F = "main-menu/execute_main_menu.rule"
rows.append(rule_row("main-menu/execute_main_menu", F, [
    case("positive", "settings", "loadMenu", f"{F}:23", {"destination": "settings"}),
    case("positive", "clock", "loadMenu", f"{F}:21", {"destination": "clock"}),
    case("positive", "radio", "loadMenu", f"{F}:24", {"destination": "radio"}),
    case("boundary", "gallery", "loadMenu", f"{F}:20", {"destination": "gallery"}),
    case("boundary", "snapshot", "loadMenu", f"{F}:17", {"destination": "snapshot"}),
    case("boundary", "tutorial", "loadMenu", f"{F}:14", {"destination": "tutorial"}),
    case("boundary", "fun stuff", "loadMenu", f"{F}:16", {"destination": "fun"}),
    case("boundary", "personal report", "loadMenu", f"{F}:18", {"destination": "personal-report"}),
    case("boundary", "introductions", "loadMenu", f"{F}:22", {"destination": "introductions"}),
    case("boundary", "yoga", "loadMenu", f"{F}:25", {"destination": "exercise"}),
], [("qzx florp", f"{F}:12-26")]))

F = "main-menu/execute_personal_report.rule"
rows.append(rule_row("main-menu/execute_personal_report", F, [
    case("positive", "weather", "loadMenu", f"{F}:16", {"destination": "weather"}),
    case("boundary", "full report", "loadMenu", f"{F}:15", {"destination": "full-report"}),
    case("boundary", "calendar", "loadMenu", f"{F}:17", {"destination": "calendar"}),
    case("boundary", "commute", "loadMenu", f"{F}:18", {"destination": "commute"}),
    case("boundary", "news", "loadMenu", f"{F}:19", {"destination": "news"}),
], [("qzx florp", f"{F}:13-20")]))

# The two time-factory rules: whole-rule gate, every utterance refuses.
TIME_F = {
    "clock/alarm_timer_ampm": "clock/alarm_timer_ampm.rule",
    "clock/alarm_set_value": "clock/alarm_set_value.rule",
}
time_rows = []
for rule, src in TIME_F.items():
    err = f"Unsupported NLU factory dependencies for public rule '{rule}': time"
    time_rows.append({
        "rule": rule,
        "source": src,
        "dependency": "time",
        "error": err,
        "refusalUtterances": [
            "am", "pm", "a.m.", "p.m.", "noon", "morning", "seven thirty am",
            "set an alarm", "5 pm", "one day from now", "3 days", "qzx florp",
        ],
    })

fixture = {
    "schema": "phoenix.nlu.n03-clock-settings-menu-fixture",
    "referenceRevision": REV,
    "referenceSourceRoot": SRC,
    "groups": ["clock/", "settings/", "main-menu/"],
    "timeFactoryGate": {
        "dependency": "time",
        "referenceFactoryFst": "build/data/en-us/factory_rules/time.fst",
        "referenceFactorySha256": "ccc50d3c0fb06e43e75433fa828d370c787429a443bfa407c6e91be73cd9d86b",
        "recoveredSource": "packages/nlu/resources/factory-sources/time.grm",
        "status": "unsupported",
        "rationale": "The only source for the time factory does not parse: the AST lexer emits a COLON token for ':' in the literal-colon forms '?(?: ...)'; compiler.l lists ':' as a word character. No non-time arm can be certified arm-for-arm while the factory is absent, so the whole-rule refusal is retained.",
    },
    "namedRules": rows,
    "timeRules": time_rows,
}
with open("packages/nlu/test/fixtures/clock-settings-menu.json", "w") as fh:
    json.dump(fixture, fh, indent=1)
    fh.write("\n")

print("rules:", len(rows))
print("cases:", sum(len(r["cases"]) for r in rows))
print("time rules:", len(time_rows), "refusals:", sum(len(r["refusalUtterances"]) for r in time_rows))
