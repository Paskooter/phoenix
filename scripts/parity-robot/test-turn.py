#!/usr/bin/env python3
"""Pure tests for the read-only turn observer's display capture planner."""
import importlib.util
from pathlib import Path
import sys
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


if __name__ == '__main__':
    unittest.main()
