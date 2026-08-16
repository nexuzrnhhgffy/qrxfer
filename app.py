from qrxfer.server import create_app, serve

app = create_app()

if __name__ == "__main__":
    serve(host="0.0.0.0", port=8080, open_browser=True)
