#!/usr/bin/env python
import ssl
import asyncio
from daphne.server import Server
from videocall_project.asgi import application

ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
ssl_context.load_cert_chain('cert.pem', 'key.pem')

server = Server(
    application,
    endpoints=['ssl:8000:privateKey=key.pem:certKey=cert.pem']
)

if __name__ == '__main__':
    asyncio.run(server.run())
