"""Ephemeral WebRTC signaling. File bytes never pass through this application."""
import base64
import json
import secrets
import threading
import time
import uuid
from io import BytesIO
from urllib.parse import urlsplit

import qrcode
from rest_framework.decorators import api_view, parser_classes
from rest_framework.exceptions import ParseError
from rest_framework.parsers import BaseParser
from rest_framework.response import Response

TTL_SECONDS = 15 * 60
MAX_ROOMS = 128
MAX_BODY = 96 * 1024
rooms = {}
lock = threading.Lock()


class SmallJSONParser(BaseParser):
    media_type = 'application/json'

    def parse(self, stream, media_type=None, parser_context=None):
        # Bound signaling requests without reading large request bodies into RAM.
        body = stream.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ParseError('Connection message is too large.')
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError):
            raise ParseError('Invalid JSON.')
        if not isinstance(value, dict):
            raise ParseError('Expected a JSON object.')
        return value


def prune():
    for room_id in list(rooms):
        if rooms[room_id]['expires'] <= time.monotonic():
            del rooms[room_id]


def valid_description(value, kind):
    return (isinstance(value, dict) and value.get('type') == kind
            and isinstance(value.get('sdp'), str)
            and 0 < len(value['sdp']) <= 60000)


def result(data, status=200):
    response = Response(data, status=status)
    response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@parser_classes([SmallJSONParser])
def create(request):
    offer = request.data.get('offer')
    origin = request.data.get('origin', '')
    if not valid_description(offer, 'offer'):
        return result({'detail': 'A valid WebRTC offer is required.'}, 400)
    try:
        parsed = urlsplit(origin) if isinstance(origin, str) else None
        valid_origin = (parsed and parsed.scheme in ('http', 'https') and parsed.hostname
                        and not parsed.username and not parsed.password
                        and parsed.path in ('', '/') and not parsed.query and not parsed.fragment
                        and len(origin) < 300)
        if parsed:
            parsed.port  # Validate malformed ports as well.
    except ValueError:
        valid_origin = False
    if not valid_origin:
        return result({'detail': 'A valid frontend origin is required.'}, 400)
    room_id = str(uuid.uuid4())
    token = secrets.token_urlsafe(32)
    link = f'{origin.rstrip("/")}/receive/{room_id}'
    image = BytesIO()
    qrcode.make(link).save(image, format='PNG')
    with lock:
        prune()
        if len(rooms) >= MAX_ROOMS:
            return result({'detail': 'All connection slots are busy. Try again shortly.'}, 503)
        rooms[room_id] = {'offer': {'type': 'offer', 'sdp': offer['sdp']}, 'answer': None,
                          'sender_token': token, 'expires': time.monotonic() + TTL_SECONDS}
    return result({'id': room_id, 'sender_token': token, 'receive_url': link,
                   'expires_in': TTL_SECONDS,
                   'qr_image': 'data:image/png;base64,' + base64.b64encode(image.getvalue()).decode()}, 201)


@api_view(['GET', 'POST', 'DELETE'])
@parser_classes([SmallJSONParser])
def session(request, room_id):
    with lock:
        prune()
        room = rooms.get(str(room_id))
        if room is None:
            return result({'detail': 'This share has expired or ended. Ask the sender for a new QR code.'}, 404)
        token = request.headers.get('X-Sender-Token', '')
        sender = secrets.compare_digest(token, room['sender_token'])
        if request.method == 'DELETE':
            if not sender:
                return result({'detail': 'Only the sender can end this share.'}, 403)
            del rooms[str(room_id)]
            return result(None, 204)
        if request.method == 'GET':
            if token and not sender:
                return result({'detail': 'Invalid sender token.'}, 403)
            if sender:
                return result({'answer': room['answer']})
            if room['answer'] is not None:
                return result({'detail': 'This share already has a receiver. Ask for a new QR code.'}, 409)
            return result({'offer': room['offer']})
        answer = request.data.get('answer')
        if not valid_description(answer, 'answer'):
            return result({'detail': 'A valid WebRTC answer is required.'}, 400)
        if room['answer'] is not None:
            return result({'detail': 'Another receiver has already connected.'}, 409)
        room['answer'] = {'type': 'answer', 'sdp': answer['sdp']}
        return result({'connected': True})
