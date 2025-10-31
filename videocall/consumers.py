# videocall/consumers.py
import json
from channels.generic.websocket import AsyncWebsocketConsumer


class SignalingConsumer(AsyncWebsocketConsumer):
    # In-memory rooms (for demo/dev; replace with DB/Redis in production)
    rooms = {}  # { room_name: { "participants": {chan_id: {...}}, "order": [] } }

    def get_room(self):
        if self.room_name not in self.rooms:
            self.rooms[self.room_name] = {"participants": {}, "order": []}
        return self.rooms[self.room_name]

    async def connect(self):
        self.room_name = self.scope["url_route"]["kwargs"]["room_name"]
        self.room_group_name = f"signaling_{self.room_name}"
        self.channel_id = self.channel_name

        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()

        room = self.get_room()
        room["order"].append(self.channel_id)

        # Add participant placeholder first
        room["participants"][self.channel_id] = {
            "channel": self.channel_id,
            "name": "Guest",   # will be replaced if client sends `join`
            "mic": "off",
            "cam": "off",
            "videoOn": False,
            "handRaised": False,
        }

        # Polite rule: first in room = polite = True; others = False
        polite = True if room["order"][0] == self.channel_id else False

        # Tell this client its ID and polite flag
        await self.send(text_data=json.dumps({
            "type": "welcome",
            "channel": self.channel_id,
            "polite": polite,
        }))

        # Send snapshot of all participants (including self)
        await self.send(text_data=json.dumps({
            "type": "participants",
            "participants": list(room["participants"].values())
        }))

        # Notify others (they'll get real name after join)
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "participant_joined",
                "participant": room["participants"][self.channel_id],
                "sender_channel": self.channel_id,
            }
        )

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

        room = self.rooms.get(self.room_name)
        if not room:
            return

        if self.channel_id in room["participants"]:
            room["participants"].pop(self.channel_id, None)
        if self.channel_id in room.get("order", []):
            room["order"].remove(self.channel_id)

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "participant_left",
                "channel": self.channel_id,
            }
        )

        if not room["participants"]:
            self.rooms.pop(self.room_name, None)

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data)
        except Exception:
            return
        
        msg_type = data.get("type")
        print(f"📩 Incoming WS message: type={msg_type}, from={self.channel_id}")
        
        if msg_type == "gaze_status":
            print(f"🎯 GAZE_STATUS received: user={data.get('user')}, gaze={data.get('gaze')}")

        # Direct signaling
        if msg_type in ("offer", "answer", "ice_candidate"):
            to_channel = data.get("to")
            if to_channel:
                await self.channel_layer.send(
                    to_channel,
                    {
                        "type": "signal",
                        "message": {**data, "sender_channel": self.channel_id},
                    }
                )
            return

        # 👇 New: join with name
        if msg_type == "join":
            room = self.get_room()
            part = room["participants"].get(self.channel_id, {})
            part.update({
                "name": data.get("name", "Guest"),
            })
            room["participants"][self.channel_id] = part

            # Notify group of update
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "participant_updated",
                    "participant": {**part, "channel": self.channel_id},
                    "sender_channel": self.channel_id,
                }
            )
            return

        # Participant state updates
        if msg_type in ("name_update", "mic_toggle", "cam_toggle", "hand_toggle"):
            room = self.get_room()
            part = room["participants"].get(self.channel_id, {})
            part.update(data)
            room["participants"][self.channel_id] = part

            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "participant_updated",
                    "participant": {**part, "channel": self.channel_id},
                    "sender_channel": self.channel_id,
                }
            )
            return

        # Chat
        if msg_type == "chat":
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "chat_message",
                    "message": {"by": data.get("by", "Guest"), "text": data.get("text", "")},
                    "sender_channel": self.channel_id,
                }
            )
            return

        # Leave
        if msg_type == "bye":
            await self.disconnect(1000)

        if msg_type == "gaze_status":
            print("📡 Broadcasting gaze_update to group:", self.room_group_name)
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "gaze_update",
                    "user": data.get("user", "Guest"),
                    "gaze": data.get("gaze", "CENTER"),
                    "ts": data.get("ts"),
                    "sender_channel": self.channel_id,
                }
            )
            return

    # ==== Group event handlers ====
    async def participant_joined(self, event):
        if event.get("sender_channel") != self.channel_id:
            await self.send(text_data=json.dumps({
                "type": "participant_joined",
                "participant": event["participant"],
            }))

    async def gaze_update(self, event):
        await self.send(text_data=json.dumps({
            "type": "gaze_update",
            "user": event["user"],
            "gaze": event["gaze"],
            "ts": event["ts"],
            "channel": event["sender_channel"],
        }))

    async def participant_left(self, event):
        await self.send(text_data=json.dumps(event))

    async def participant_updated(self, event):
        if event.get("sender_channel") != self.channel_id:
            await self.send(text_data=json.dumps(event))

    async def chat_message(self, event):
        if event.get("sender_channel") != self.channel_id:
            await self.send(text_data=json.dumps(event))

    async def signal(self, event):
        await self.send(text_data=json.dumps(event["message"]))
