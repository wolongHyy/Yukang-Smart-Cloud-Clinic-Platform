from __future__ import annotations

from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)

    async def connect(self, edge_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[edge_id].add(websocket)

    def disconnect(self, edge_id: str, websocket: WebSocket) -> None:
        connections = self._connections.get(edge_id)
        if not connections:
            return
        connections.discard(websocket)
        if not connections:
            self._connections.pop(edge_id, None)

    def online_edges(self) -> set[str]:
        return set(self._connections)

    async def send(self, edge_id: str, payload: dict) -> bool:
        sent = False
        for websocket in list(self._connections.get(edge_id, set())):
            try:
                await websocket.send_json(payload)
                sent = True
            except Exception:
                self.disconnect(edge_id, websocket)
        return sent
