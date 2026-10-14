"""Generate a small native Therion-compatible LOX fixture, not a proprietary sample."""
import struct
from pathlib import Path
P = Path(__file__).resolve().parents[1] / 'public/sample/demo.lox'
def u(*values): return struct.pack('<' + 'I'*len(values), *values)
def xyz(x,y,z): return struct.pack('<ddd',x,y,z)
def chunk(kind,records,count,blob=b''): return u(kind,len(records),count,len(blob))+records+blob
survey = chunk(1,u(0,0,0,0,0,0),1)
station_records=b''
points=[(0,0,0),(12,0,-2),(24,5,-5),(38,5,-9)]
for i,pt in enumerate(points): station_records+=u(i,0,0,0,0,0,0)+xyz(*pt)
stations=chunk(2,station_records,len(points))
shots=b''
for i in range(len(points)-1):
    shots+=u(i,i+1)+struct.pack('<8d',*([2.0]*8))+u(0,0,0)+struct.pack('<d',60.)
shot_chunk=chunk(3,shots,len(points)-1)
# Connected rings, 8 points per cross section, 3D curved tunnel walls.
import math
verts=[]; triangles=[]
for j,(x,y,z) in enumerate(points):
    for k in range(8):
        angle=2*math.pi*k/8
        verts.append((x,y+2.5*math.cos(angle),z+2*math.sin(angle)))
for j in range(len(points)-1):
    for k in range(8):
        a=j*8+k;b=j*8+(k+1)%8;c=(j+1)*8+k;d=(j+1)*8+(k+1)%8
        triangles.extend([(a,b,c),(b,d,c)])
vp=b''.join(xyz(*v) for v in verts)
tp=b''.join(u(*tri) for tri in triangles)
scrap_record=u(0,0,len(verts),0,len(vp),len(triangles),len(vp),len(tp))
scrap=chunk(4,scrap_record,1,vp+tp)
P.parent.mkdir(parents=True,exist_ok=True)
P.write_bytes(survey+stations+shot_chunk+scrap)
print(P, P.stat().st_size)
