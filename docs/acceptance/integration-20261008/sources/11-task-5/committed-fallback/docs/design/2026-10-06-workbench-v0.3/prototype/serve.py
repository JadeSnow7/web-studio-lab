from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path
import argparse
p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8765);args=p.parse_args()
root=str(Path(__file__).resolve().parent)
print(f'Local design prototype: http://127.0.0.1:{args.port}/Main.dc.html',flush=True)
ThreadingHTTPServer(('127.0.0.1',args.port),partial(SimpleHTTPRequestHandler,directory=root)).serve_forever()
