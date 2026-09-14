#!/usr/bin/env python3
"""Pure tests for the read-only turn observer's display capture planner."""
import argparse
import asyncio
import contextlib
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('turn_under_test', HERE / 'turn.py')
turn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(turn)


def display_event(view_ids):
    children = []
    for index, view_id in enumerate(view_ids):
        children.append({
            'id': 'slim-%d' % index,
            'type': 'SLIM',
            'config': {
                'display': {
                    'type': 'DISPLAY',
                    'id': 'display-%d' % index,
                    'view': {
                        'type': 'SKILL',
                        'name': 'MIM_VIEW',
                        'context': {
                            'type': 'Javascript',
                            'data': {
                                'viewConfig': {'type': 'View', 'id': view_id},
                                'componentConfigs': []
                            }
                        }
                    }
                }
            }
        })
    return {
        'elapsedMs': 12,
        'event': {
            'ts': 123,
            'type': 'SKILL_ACTION',
            'requestID': 'request-1',
            'transID': 'trans-1',
            'data': {
                'action': {
                    'type': 'JCP',
                    'config': {
                        'version': '2.0',
                        'jcp': {'id': 'jcp-1', 'type': 'SEQUENCE', 'children': children}
                    }
                }
            }
        }
    }


class DisplayCapturePlannerTests(unittest.TestCase):
    def test_extracts_ordered_actions_and_correlation(self):
        actions = turn._display_actions_from_event(display_event(['eventView', 'eventView']), 4)
        self.assertEqual([action['viewId'] for action in actions], ['eventView', 'eventView'])
        self.assertEqual([action['displayIndex'] for action in actions], [0, 1])
        self.assertEqual(actions[0]['eventIndex'], 4)
        self.assertEqual(actions[0]['requestID'], 'request-1')
        self.assertEqual(actions[0]['transID'], 'trans-1')
        self.assertEqual(
            actions[1]['actionPath'],
            ['data', 'action', 'config', 'jcp', 'children', 1, 'config', 'display'])

    def test_action_correlation_is_present_for_a_source_display(self):
        action = turn._display_actions_from_event(display_event(['eventView']), 4)[0]
        action.update({'viewOccurrence': 1, 'displayOrdinal': 1, 'captureKey': 'eventView#1'})
        correlation = turn._action_correlation(action)
        self.assertIsNotNone(correlation)
        self.assertEqual(correlation['requestID'], 'request-1')
        self.assertEqual(correlation['transID'], 'trans-1')
        self.assertEqual(correlation['captureKey'], 'eventView#1')
        self.assertIsNone(turn._action_correlation(None))

    def test_duplicate_view_ids_get_distinct_ordered_captures(self):
        rows = [display_event(['eventView', 'eventView'])]
        planner = turn.DisplayCapturePlanner(0.5)

        planner.update({'view': 'eyeView', 'viewInstance': 'eye-1'}, 0.0, rows)
        _, request = planner.update({'view': 'eyeView', 'viewInstance': 'eye-1'}, 0.5, rows)
        self.assertEqual(request['viewId'], 'eyeView')
        self.assertEqual(request['captureOrdinal'], 1)
        planner.captured(request, 0.5)

        planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 1.0, rows)
        _, request = planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 1.5, rows)
        self.assertEqual(request['viewOccurrence'], 1)
        self.assertEqual(request['captureOrdinal'], 2)
        planner.captured(request, 1.5)

        planner.update({'view': 'eyeView', 'viewInstance': 'eye-2'}, 2.0, rows)
        planner.update({'view': 'eventView', 'viewInstance': 'event-2'}, 2.5, rows)
        _, request = planner.update({'view': 'eventView', 'viewInstance': 'event-2'}, 3.0, rows)
        self.assertEqual(request['viewOccurrence'], 2)
        self.assertEqual(request['captureOrdinal'], 3)
        planner.captured(request, 3.0)
        planner.finish(rows, 3.1)

        actions = planner.public_actions()
        self.assertEqual([action['captureStatus'] for action in actions], ['captured', 'captured'])
        self.assertEqual([action['captureOrdinal'] for action in actions], [2, 3])

    def test_four_same_id_actions_capture_one_render_per_view_instance(self):
        rows = [display_event(['eventView', 'eventView', 'eventView', 'eventView'])]
        planner = turn.DisplayCapturePlanner(0.5)

        planner.update({'view': 'eyeView', 'viewInstance': 'eye-1'}, 0.0, rows)
        _, request = planner.update({'view': 'eyeView', 'viewInstance': 'eye-1'}, 0.5, rows)
        planner.captured(request, 0.5)

        captures = []
        for index in range(4):
            instance = 'event-%d' % (index + 1)
            start = 1.0 + index
            planner.update({'view': 'eventView', 'viewInstance': instance}, start, rows)
            _, request = planner.update({'view': 'eventView', 'viewInstance': instance}, start + 0.5, rows)
            captures.append(request)
            planner.captured(request, start + 0.5)

        planner.finish(rows, 5.1)
        self.assertEqual([request['viewOccurrence'] for request in captures], [1, 2, 3, 4])
        self.assertEqual([request['viewInstance'] for request in captures],
                         ['event-1', 'event-2', 'event-3', 'event-4'])
        self.assertEqual([request['captureOrdinal'] for request in captures], [2, 3, 4, 5])
        self.assertEqual([action['captureStatus'] for action in planner.public_actions()],
                         ['captured', 'captured', 'captured', 'captured'])

    def test_same_id_without_a_new_view_boundary_fails_closed(self):
        rows = [display_event(['eventView', 'eventView'])]
        planner = turn.DisplayCapturePlanner(0.1)
        planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 0.0, rows)
        _, request = planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 0.1, rows)
        planner.captured(request, 0.1)
        with self.assertRaises(turn.CaptureError):
            planner.finish(rows, 1.0)
        self.assertEqual(planner.errors[0]['viewId'], 'eventView')

    def test_expected_sequence_rejects_unrecorded_extra_matching_action(self):
        rows = [display_event(['eventView', 'eventView', 'eventView'])]
        planner = turn.DisplayCapturePlanner(0.1, expected_view_ids=['eventView', 'eventView'])
        with self.assertRaises(turn.CaptureError):
            planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 0.0, rows)
        self.assertIn('extra DISPLAY', planner.errors[0]['message'])
        self.assertEqual(planner.errors[0]['displayOrdinal'], 3)

    def test_expected_sequence_rejects_view_order_mismatch(self):
        rows = [display_event(['eventView'])]
        planner = turn.DisplayCapturePlanner(0.1, expected_view_ids=['weatherView'])
        with self.assertRaises(turn.CaptureError):
            planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 0.0, rows)
        self.assertEqual(planner.errors[0]['expectedViewId'], 'weatherView')

    def test_allow_listed_prelude_is_recorded_and_not_captured(self):
        rows = [display_event(['whoIsThisMenu']), display_event(['eventView', 'eventView'])]
        planner = turn.DisplayCapturePlanner(
            0.5,
            expected_view_ids=['eventView', 'eventView'],
            allowed_prelude_view_ids=['whoIsThisMenu'],
        )
        planner.update({'view': 'whoIsThisMenu', 'viewInstance': 'identity-1'}, 0.0, rows[:1])
        _, request = planner.update(
            {'view': 'whoIsThisMenu', 'viewInstance': 'identity-1'}, 1.0, rows[:1])
        self.assertIsNone(request)
        self.assertEqual(planner.public_excluded_actions()[0]['captureStatus'], 'excluded-prelude')
        self.assertEqual(planner.public_excluded_actions()[0]['requestID'], 'request-1')

        planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 1.1, rows)
        _, request = planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 1.6, rows)
        planner.captured(request, 1.6)
        planner.update({'view': 'eyeView', 'viewInstance': 'eye-2'}, 1.7, rows)
        planner.update({'view': 'eventView', 'viewInstance': 'event-2'}, 1.8, rows)
        _, request = planner.update({'view': 'eventView', 'viewInstance': 'event-2'}, 2.4, rows)
        planner.captured(request, 2.4)
        planner.finish(rows, 2.5)
        self.assertEqual([item['viewId'] for item in planner.public_actions()],
                         ['eventView', 'eventView'])

    def test_allow_listed_prelude_is_rejected_after_target_sequence_starts(self):
        planner = turn.DisplayCapturePlanner(
            0.1,
            expected_view_ids=['eventView'],
            allowed_prelude_view_ids=['whoIsThisMenu'],
        )
        planner.update({'view': 'eventView', 'viewInstance': 'event-1'}, 0.0,
                       [display_event(['eventView'])])
        with self.assertRaises(turn.CaptureError):
            planner.update({'view': 'whoIsThisMenu', 'viewInstance': 'identity-1'}, 0.1,
                           [display_event(['eventView']), display_event(['whoIsThisMenu'])])
        self.assertIn('extra DISPLAY', planner.errors[0]['message'])

    def test_unique_ids_keep_one_capture_each(self):
        planner = turn.DisplayCapturePlanner(0.5)
        planner.update({'view': 'eyeView'}, 0.0, [])
        _, request = planner.update({'view': 'eyeView'}, 0.5, [])
        planner.captured(request, 0.5)
        planner.update({'view': 'weatherTempView'}, 1.0, [])
        _, request = planner.update({'view': 'weatherTempView'}, 1.5, [])
        planner.captured(request, 1.5)
        planner.update({'view': 'eyeView'}, 2.0, [])
        planner.finish([], 3.0)
        self.assertEqual(planner._next_capture_ordinal, 3)

    def test_missing_view_id_is_rejected(self):
        row = display_event(['eventView'])
        row['event']['data']['action']['config']['jcp']['children'][0]['config']['display']['view']['context']['data'].pop('viewConfig')
        with self.assertRaises(turn.CaptureError):
            turn._display_actions_from_event(row, 0)

    def test_filename_preserves_legacy_shape_and_ordinal(self):
        self.assertEqual(
            turn._screenshot_path(Path('/tmp/calendar.json'), 1),
            Path('/tmp/calendar-view-1.png'))
        self.assertEqual(
            turn._screenshot_path(Path('/tmp/calendar.json'), 3),
            Path('/tmp/calendar-view-3.png'))

    def test_idle_preflight_requires_full_idle_snapshot(self):
        idle = {'skill': '@be/idle', 'view': 'eyeView', 'listen': 'Idle', 'talking': False}
        self.assertTrue(turn._is_idle_snapshot(idle))
        self.assertTrue(turn._is_idle_snapshot({**idle, 'skill': {'name': '@be/idle'}}))
        for key, value in [('view', 'eventView'), ('listen', 'Listening'), ('talking', True)]:
            candidate = dict(idle)
            candidate[key] = value
            self.assertFalse(turn._is_idle_snapshot(candidate))

    def test_screenshot_digest_and_size_are_reported_from_same_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'view.png'
            content = b'\x89PNG\r\nrobot-view'
            path.write_bytes(content)
            digest, size = turn._file_digest_and_size(path)
            self.assertEqual(digest, hashlib.sha256(content).hexdigest())
            self.assertEqual(size, len(content))

    def test_fixture_copy_is_private_immutable_and_watched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'fixture.json'
            copy = root / 'evidence' / 'fixture.json'
            content = json.dumps({
                'caseId': 'calendar-four-card-field-matrix',
                'integrity': {'casesSha256': 'a' * 64},
            }).encode('utf-8')
            source.write_bytes(content)
            source.chmod(0o600)
            snapshot = turn.ImmutableFixtureSnapshot.capture(source, copy_path=copy)
            metadata = snapshot.metadata()
            self.assertEqual(metadata['caseId'], 'calendar-four-card-field-matrix')
            self.assertEqual(metadata['bytes'], len(content))
            self.assertEqual(metadata['sha256'], hashlib.sha256(content).hexdigest())
            self.assertEqual(metadata['copySha256'], metadata['sha256'])
            self.assertEqual(metadata['copyBytes'], len(content))
            self.assertEqual((copy.stat().st_mode & 0o777), 0o600)
            snapshot.verify_unchanged()
            self.assertTrue(snapshot.metadata()['verifiedUnchanged'])

            source.write_text(json.dumps({
                'caseId': 'calendar-no-view-empty',
                'integrity': {'casesSha256': 'a' * 64},
            }))
            source.chmod(0o600)
            with self.assertRaises(turn.CaptureError):
                snapshot.verify_unchanged()
            with self.assertRaises(turn.CaptureError):
                turn.ImmutableFixtureSnapshot.capture(source, copy_path=copy)

    def test_run_receipt_has_fixture_copy_bytes_and_display_correlation(self):
        class FakeWebSocket:
            def __init__(self, payload):
                self.payload = payload

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def _events(self):
                yield self.payload

            def __aiter__(self):
                return self._events()

        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / 'fixture.json'
                source.write_text(json.dumps({
                    'caseId': 'calendar-four-card-field-matrix',
                    'integrity': {'casesSha256': 'b' * 64},
                }))
                source.chmod(0o600)
                output = root / 'capture.json'
                event = display_event(['eventView'])['event']
                old_connect = turn.websockets.connect
                old_evaluate = turn.evaluate
                old_screenshot = turn.screenshot
                snapshot_calls = 0

                async def fake_evaluate(port, slot, expression):
                    nonlocal snapshot_calls
                    if expression == turn.SNAPSHOT:
                        snapshot_calls += 1
                        value = ({
                            'skill': '@be/idle', 'view': 'eyeView',
                            'viewInstance': 'eye-1', 'listen': 'Idle', 'talking': False,
                        } if snapshot_calls == 1 else {
                            'skill': '@be/calendar', 'view': 'eventView',
                            'viewInstance': 'event-1', 'listen': 'Idle', 'talking': False,
                        })
                        return {'result': {'value': value}}
                    return {'result': {'value': True}}

                async def fake_screenshot(port, slot, path):
                    path.write_bytes(b'\x89PNG\r\nS13')
                    return {'page': slot, 'screenshot': str(path)}

                turn.websockets.connect = lambda *args, **kwargs: FakeWebSocket(json.dumps(event))
                turn.evaluate = fake_evaluate
                turn.screenshot = fake_screenshot
                args = argparse.Namespace(
                    out=output, fixture_file=source, fixture_copy=root / 'fixture-copy.json',
                    fixture_sha256=None, fixture_cases_sha256='b' * 64,
                    screenshot_delay=0.0, screenshots=True,
                    expected_view_ids=['eventView'], native_port=18090, cdp_port=19223,
                    allowed_prelude_view_ids=None,
                    slot='test', mode='global', text=None, observe_only=True,
                    followup_text=None, followup_skill=None, followup_rule=None, visuals=False,
                    require_idle=False, duration=0.25,
                )
                try:
                    with contextlib.redirect_stdout(io.StringIO()):
                        await turn.run(args)
                finally:
                    turn.websockets.connect = old_connect
                    turn.evaluate = old_evaluate
                    turn.screenshot = old_screenshot
                report = json.loads(output.read_text())
                self.assertTrue(report['preflight']['idle'])
                self.assertTrue(report['fixture']['immutable'])
                self.assertTrue(report['fixture']['verifiedUnchanged'])
                self.assertEqual(len(report['screenshots']), 1)
                capture = report['screenshots'][0]
                self.assertGreater(capture['bytes'], 0)
                self.assertEqual(capture['bytes'], len(b'\x89PNG\r\nS13'))
                self.assertEqual(capture['actionCorrelation']['requestID'], 'request-1')
                self.assertEqual(capture['actionCorrelation']['captureKey'], 'eventView#1')

        asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main()
