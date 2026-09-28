import json
from rest_framework.test import APITestCase
from . import views

class SignalingTests(APITestCase):
    def setUp(self):
        views.rooms.clear()
        self.offer = {'type': 'offer', 'sdp': 'v=0\r\no=- sender'}
        self.answer = {'type': 'answer', 'sdp': 'v=0\r\no=- receiver'}
    def create(self):
        return self.client.post('/api/sessions/', {'offer': self.offer, 'origin': 'http://192.168.1.5:3000'}, format='json')
    def test_ephemeral_session_round_trip(self):
        created = self.create(); self.assertEqual(created.status_code, 201); data = created.json()
        self.assertIn('/receive/', data['receive_url']); self.assertTrue(data['qr_image'].startswith('data:image/png;base64,')); self.assertNotIn('file', data)
        self.assertEqual(self.client.get(f'/api/sessions/{data["id"]}/').json()['offer'], self.offer)
        self.assertEqual(self.client.post(f'/api/sessions/{data["id"]}/', {'answer': self.answer}, format='json').status_code, 200)
        self.assertEqual(self.client.get(f'/api/sessions/{data["id"]}/', HTTP_X_SENDER_TOKEN=data['sender_token']).json()['answer'], self.answer)
        self.assertEqual(self.client.delete(f'/api/sessions/{data["id"]}/', HTTP_X_SENDER_TOKEN=data['sender_token']).status_code, 204)
    def test_rejects_invalid_or_large_signal(self):
        self.assertEqual(self.client.post('/api/sessions/', {}, format='json').status_code, 400)
        self.assertEqual(self.client.post('/api/sessions/', {'offer': self.offer, 'origin': 'ftp://host'}, format='json').status_code, 400)
        huge = json.dumps({'offer': {'type': 'offer', 'sdp': 'x' * 100000}, 'origin': 'http://host'})
        self.assertEqual(self.client.post('/api/sessions/', huge, content_type='application/json').status_code, 400)
    def test_only_one_receiver_and_sender_may_delete(self):
        data = self.create().json(); url = f'/api/sessions/{data["id"]}/'
        self.assertEqual(self.client.post(url, {'answer': self.answer}, format='json').status_code, 200)
        self.assertEqual(self.client.get(url).status_code, 409); self.assertEqual(self.client.delete(url).status_code, 403)
    def test_expired_sessions_are_unavailable(self):
        data = self.create().json(); views.rooms[data['id']]['expires'] = 0
        self.assertEqual(self.client.get(f'/api/sessions/{data["id"]}/').status_code, 404)
    def test_cors_and_storage_free(self):
        response = self.client.options('/api/sessions/', HTTP_ORIGIN='http://192.168.1.5:3000', HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST', HTTP_ACCESS_CONTROL_REQUEST_HEADERS='x-sender-token')
        self.assertEqual(response['Access-Control-Allow-Origin'], '*')
        self.assertIn('x-sender-token', response['Access-Control-Allow-Headers'].lower())
        self.assertFalse(hasattr(views, 'save_file_in_chunks'))
