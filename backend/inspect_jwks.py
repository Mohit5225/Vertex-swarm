import asyncio
import aiohttp
import json

async def fetch_jwks():
    async with aiohttp.ClientSession() as session:
        async with session.get(
            'https://ep-jolly-feather-aiaavjnk.neonauth.c-4.us-east-1.aws.neon.tech/neondb/auth/.well-known/jwks.json',
            timeout=aiohttp.ClientTimeout(total=10)
        ) as response:
            data = await response.json()
            print(json.dumps(data, indent=2))

asyncio.run(fetch_jwks())
