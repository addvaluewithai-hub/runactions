import argparse
import json
import subprocess
import tempfile
from pathlib import Path


def run(cmd):
    print('+', ' '.join(map(str, cmd)))
    subprocess.run([str(x) for x in cmd], check=True)


def encode(out, inputs, filt, maps, fps=30):
    cmd=['ffmpeg','-hide_banner','-loglevel','error','-y',*inputs,'-filter_complex',filt]
    for m in maps: cmd += ['-map',m]
    cmd += ['-an','-r',str(fps),'-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p',str(out)]
    run(cmd)


def pip_filter(w,h,pip,presenter_label='1:v'):
    pw=max(180,int(w*float(pip.get('width',.25))))
    ph=int(pw*1.28)
    margin=int(pip.get('margin',36)); bottom=int(pip.get('bottom',132)); border=int(pip.get('border',4))
    # Presenter is portrait footage. Scale by width then take a deterministic compact face window.
    # Avoid expression commas in crop parameters so the filter graph parses identically across ffmpeg builds.
    prep=(f'[{presenter_label}]scale={pw}:-2,crop={pw}:{ph}:0:0,'
          f'pad=iw+{border*2}:ih+{border*2}:{border}:{border}:color=white,setsar=1[pip];')
    overlay=f'[base][pip]overlay=W-w-{margin}:H-h-{bottom}:shortest=1,format=yuv420p[v]'
    return prep+overlay


def render_presenter(src,start,dur,out,w,h,fps):
    vf=f'[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps},format=yuv420p[v]'
    encode(out,['-ss',f'{start:.3f}','-t',f'{dur:.3f}','-i',src],vf,['[v]'],fps)


def render_product(src,presenter,pstart,sstart,dur,out,w,h,fps,pip,product_asset):
    crop=product_asset.get('crop',{})
    top=int(crop.get('top',110)); bottom=int(crop.get('bottom',100))
    # Product source is a narrow phone screen recording. Remove browser / Android chrome,
    # then preserve the complete app view over a soft background instead of destructive fill-cropping.
    filt=(
      f'[0:v]crop=iw:ih-{top+bottom}:0:{top},split=2[cleanbg][cleanfg];'
      f'[cleanbg]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=32,eq=brightness=-0.16:saturation=.75[bg];'
      f'[cleanfg]scale={int(w*.84)}:{int(h*.91)}:force_original_aspect_ratio=decrease,setsar=1[fg];'
      f'[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps}[base];'
      + pip_filter(w,h,pip)
    )
    inputs=['-ss',f'{sstart:.3f}','-t',f'{dur:.3f}','-i',src,'-ss',f'{pstart:.3f}','-t',f'{dur:.3f}','-i',presenter]
    encode(out,inputs,filt,['[v]'],fps)


def render_image(src,presenter,pstart,dur,out,w,h,fps,pip=None,motion=''):
    zoom='1.0'
    x='(W-w)/2'; y='(H-h)/2'
    if motion=='slowZoom': zoom='1.06'
    if motion=='focusRight': zoom='1.20'; x='W-w-40'
    if motion=='focusTop': zoom='1.18'; y='40'
    if motion=='focusCenter': zoom='1.16'
    fg_w=int(w*float(zoom))
    filt=(
      f'[0:v]split=2[bg0][fg0];'
      f'[bg0]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=34,eq=brightness=-0.18:saturation=.78[bg];'
      f'[fg0]scale={fg_w}:{int(h*.88)}:force_original_aspect_ratio=decrease,setsar=1[fg];'
      f'[bg][fg]overlay={x}:{y},setsar=1,fps={fps}[base];'
    )
    inputs=['-loop','1','-framerate',str(fps),'-t',f'{dur:.3f}','-i',src]
    if pip:
      inputs += ['-ss',f'{pstart:.3f}','-t',f'{dur:.3f}','-i',presenter]
      filt += pip_filter(w,h,pip)
      maps=['[v]']
    else:
      filt += '[base]format=yuv420p[v]'
      maps=['[v]']
    encode(out,inputs,filt,maps,fps)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--project',required=True)
    ap.add_argument('--work',default='work')
    ap.add_argument('--out',required=True)
    args=ap.parse_args()

    root=Path.cwd(); p=json.loads(Path(args.project).read_text())
    work=Path(args.work); slug=p['slug']
    presenter=work/'presenter.mp4'; product=work/'product.mp4'
    w=int(p['canvas']['width']); h=int(p['canvas']['height']); fps=int(p.get('fps',30)); total=float(p['duration'])
    media=p['media']; pip=p.get('pip',{})

    asset_paths={
      'presenter':presenter,'product':product,
      'qr':work/'qr.jpg','mockup':work/'mockup.jpg',
      'dashboardMenu':root/f'editor/media/{slug}/dashboard_menu.jpg',
      'dashboardServices':root/f'editor/media/{slug}/dashboard_services.jpg',
      'dashboardRequests':root/f'editor/media/{slug}/dashboard_requests.jpg',
      'dashboardPerformance':root/f'editor/media/{slug}/dashboard_performance.jpg',
    }
    for key,path in asset_paths.items():
      if key in media and not path.exists(): raise FileNotFoundError(path)

    clips=sorted(next(t for t in p['tracks'] if t['id']=='visual')['clips'],key=lambda c:c['start'])
    expected=0.0
    with tempfile.TemporaryDirectory(prefix='qserve-editor-render-') as td:
      td=Path(td); segs=[]
      for i,c in enumerate(clips):
        start=float(c['start']); end=float(c['end']); dur=end-start
        if abs(start-expected)>.08: raise ValueError(f'Gap/overlap before {c["id"]}: expected {expected:.3f}, got {start:.3f}')
        if dur<=0: raise ValueError(f'Bad duration: {c["id"]}')
        out=td/f'{i:03d}.mp4'; asset=c['asset']; path=asset_paths[asset]
        a=media[asset]
        if asset=='presenter':
          render_presenter(path,float(c.get('sourceIn',start)),dur,out,w,h,fps)
        elif asset=='product':
          render_product(path,presenter,start,float(c.get('sourceIn',0)),dur,out,w,h,fps,pip,a)
        else:
          render_image(path,presenter,start,dur,out,w,h,fps,pip if c.get('pip') else None,c.get('motion',''))
        segs.append(out); expected=end
      if abs(expected-total)>.08: raise ValueError(f'Timeline ends at {expected:.3f}, expected {total:.3f}')

      concat=td/'concat.txt'; concat.write_text('\n'.join(f"file '{x.as_posix()}'" for x in segs)+'\n')
      visuals=td/'visuals.mp4'
      run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',concat,'-c','copy',visuals])

      output=Path(args.out); output.parent.mkdir(parents=True,exist_ok=True)
      # MP4 concat-copy can end a few frames short after many independently encoded
      # segments. Re-encode the final composite once, clone the last visual frame and
      # pad audio, then trim both streams to the project duration. This guarantees the
      # deliverable has a continuous video stream for the full declared timeline.
      final_filter=(
        f'[0:v]tpad=stop_mode=clone:stop_duration=1.0,fps={fps},format=yuv420p[v];'
        f'[1:a]apad=pad_dur=1.0[a]'
      )
      run([
        'ffmpeg','-hide_banner','-loglevel','error','-y',
        '-i',visuals,'-i',presenter,
        '-filter_complex',final_filter,
        '-map','[v]','-map','[a]',
        '-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p',
        '-c:a','aac','-b:a','192k','-t',f'{total:.3f}','-movflags','+faststart',output
      ])
    print(f'Rendered {output}')

if __name__=='__main__': main()
