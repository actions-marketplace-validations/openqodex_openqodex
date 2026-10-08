import os

from flask import Flask, abort, jsonify, request, send_file

app = Flask(__name__)
UPLOAD_DIR = "/srv/uploads"


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/download")
def download():
    name = request.args.get("name", "")
    path = os.path.join(UPLOAD_DIR, name)
    if not os.path.isfile(path):
        abort(404)
    return send_file(path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
