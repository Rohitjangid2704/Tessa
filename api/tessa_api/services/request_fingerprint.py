import hashlib

from fastapi import Request, UploadFile

FORM_CONTENT_TYPES = ("multipart/", "application/x-www-form-urlencoded")
HASH_CHUNK_BYTES = 1024 * 1024


async def fingerprint_upload(upload: UploadFile) -> bytes:
    digest = hashlib.sha256()
    await upload.seek(0)
    while chunk := await upload.read(HASH_CHUNK_BYTES):
        digest.update(chunk)
    await upload.seek(0)
    return digest.digest()


async def fingerprint_form(request: Request) -> bytes:
    digest = hashlib.sha256()
    form = await request.form()
    for name, value in form.multi_items():
        digest.update(name.encode())
        digest.update(b"\n")
        if isinstance(value, UploadFile):
            digest.update(await fingerprint_upload(value))
        else:
            digest.update(str(value).encode())
        digest.update(b"\n")
    return digest.digest()


async def idempotency_body(request: Request) -> bytes:
    if request.headers.get("content-type", "").startswith(FORM_CONTENT_TYPES):
        return await fingerprint_form(request)
    return await request.body()
