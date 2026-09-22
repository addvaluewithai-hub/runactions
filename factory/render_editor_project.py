import argparse, json, subprocess, tempfile
from pathlib import Path


def run(cmd):
    print('+',' '.join(map(str,cmd)))
    subprocess.run([str(x) for x in cmd],check=True)

def encode(out,inputs,filt,maps,fps=30):
    cmd=['ffmpeg','-hide_banner','-loglevel','error','-y',*inputs,'-filter_complex',filt]
    for m in maps: cmd+=['-map',m]
    cmd+=['-an','-r',str(fps),'-c:v','libx264','-preset','medium','-crf','17','-pix_fmt','yuv420p',str(out)]
    run(cmd)

def render_gap(out,dur,w,h,fps,color='#f4f0e7'):
    run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i',f'color=c={color}:s={w}x{h}:r={fps}:d={dur:.6f}','-an','-r',str(fps),'-c:v','libx264','-preset','medium','-crf','17','-pix_fmt','yuv420p',out])

def pip_filter(w,h,pip,label='1:v'):
    pw=max(180,int(w*float(pip.get('width',.25)))); ph=int(pw*1.28); m=int(pip.get('margin',36)); b=int(pip.get('bottom',132)); bd=int(pip.get('border',4))
    return f'[{label}]scale={pw}:-2,crop={pw}:{ph}:0:0,pad=iw+{bd*2}:ih+{bd*2}:{bd}:{bd}:color=white,setsar=1[pip];[base][pip]overlay=W-w-{m}:H-h-{b}:shortest=1,format=yuv420p[v]'

def fade_chain(label,dur,clip,alpha=False):
    parts=[]; cur=label; td=max(.05,float(clip.get('transitionDuration',.35)))
    if clip.get('transitionIn')=='fade':
        nxt=cur+'i'; parts.append(f'[{cur}]fade=t=in:st=0:d={min(td,dur):.3f}'+(':alpha=1' if alpha else '')+f'[{nxt}]'); cur=nxt
    if clip.get('transitionOut')=='fade':
        nxt=cur+'o'; parts.append(f'[{cur}]fade=t=out:st={max(0,dur-min(td,dur)):.3f}:d={min(td,dur):.3f}'+(':alpha=1' if alpha else '')+f'[{nxt}]'); cur=nxt
    return ';'.join(parts),cur

def render_presenter(src,start,dur,out,w,h,fps,clip):
    base=f'[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps}[base]'; f,cur=fade_chain('base',dur,clip); filt=base+(';' + f if f else '')+f';[{cur}]format=yuv420p[v]'
    encode(out,['-ss',f'{start:.3f}','-t',f'{dur:.3f}','-i',src],filt,['[v]'],fps)

def render_product(src,presenter,pstart,sstart,dur,out,w,h,fps,pip,asset,clip,use_legacy_pip):
    crop=asset.get('crop',{}); top=int(crop.get('top',110)); bottom=int(crop.get('bottom',100))
    filt=(f'[0:v]crop=iw:ih-{top+bottom}:0:{top},split=2[cleanbg][cleanfg];'
          f'[cleanbg]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=32,eq=brightness=-0.16:saturation=.75[bg];'
          f'[cleanfg]scale={int(w*.84)}:{int(h*.91)}:force_original_aspect_ratio=decrease,setsar=1[fg];'
          f'[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps}[base]')
    inputs=['-ss',f'{sstart:.3f}','-t',f'{dur:.3f}','-i',src]
    if use_legacy_pip:
        inputs+=['-ss',f'{pstart:.3f}','-t',f'{dur:.3f}','-i',presenter]; filt+=';'+pip_filter(w,h,pip); maps=['[v]']
    else:
        f,cur=fade_chain('base',dur,clip); filt+=(';' + f if f else '')+f';[{cur}]format=yuv420p[v]'; maps=['[v]']
    encode(out,inputs,filt,maps,fps)

def render_image(src,presenter,pstart,dur,out,w,h,fps,pip,clip,use_legacy_pip):
    motion=clip.get('motion',''); zoom='1.0'; x='(W-w)/2'; y='(H-h)/2'
    if motion=='slowZoom': zoom='1.06'
    if motion=='focusRight': zoom='1.20'; x='W-w-40'
    if motion=='focusTop': zoom='1.18'; y='40'
    if motion=='focusCenter': zoom='1.16'
    fw=int(w*float(zoom)); filt=(f'[0:v]split=2[bg0][fg0];[bg0]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=34,eq=brightness=-0.18:saturation=.78[bg];[fg0]scale={fw}:{int(h*.88)}:force_original_aspect_ratio=decrease,setsar=1[fg];[bg][fg]overlay={x}:{y},setsar=1,fps={fps}[base]')
    inputs=['-loop','1','-framerate',str(fps),'-t',f'{dur:.3f}','-i',src]
    if use_legacy_pip:
        inputs+=['-ss',f'{pstart:.3f}','-t',f'{dur:.3f}','-i',presenter]; filt+=';'+pip_filter(w,h,pip); maps=['[v]']
    else:
        f,cur=fade_chain('base',dur,clip); filt+=(';' + f if f else '')+f';[{cur}]format=yuv420p[v]'; maps=['[v]']
    encode(out,inputs,filt,maps,fps)

def asset_path(root,work,slug,aid,media):
    fixed={'presenter':work/'presenter.mp4','product':work/'product.mp4','qr':work/'qr.jpg','mockup':work/'mockup.jpg'}
    if aid in fixed:return fixed[aid]
    src=media[aid].get('src','')
    if src.startswith('/media/'):return root/'editor'/src.lstrip('/')
    mapping={'dashboardMenu':'dashboard_menu.jpg','dashboardServices':'dashboard_services.jpg','dashboardRequests':'dashboard_requests.jpg','dashboardPerformance':'dashboard_performance.jpg'}
    if aid in mapping:return root/f'editor/media/{slug}/{mapping[aid]}'
    raise FileNotFoundError(aid)

def esc_text(s):
    return str(s).replace('\\','\\\\').replace(':','\\:').replace("'","\\'").replace('%','\\%')

def percent_crop_filter(clip):
    cr=clip.get('crop') or {}
    if cr.get('unit')!='percent': return ''
    left=max(0,min(49,float(cr.get('left',0) or 0)));right=max(0,min(49,float(cr.get('right',0) or 0)))
    top=max(0,min(49,float(cr.get('top',0) or 0)));bottom=max(0,min(49,float(cr.get('bottom',0) or 0)))
    if left+right+top+bottom<.001:return ''
    kw=max(.02,1-(left+right)/100);kh=max(.02,1-(top+bottom)/100)
    return f',crop=trunc(iw*{kw:.6f}/2)*2:trunc(ih*{kh:.6f}/2)*2:iw*{left/100:.6f}:ih*{top/100:.6f}'

def rounded_alpha(radius):
    r=max(1,int(round(float(radius))))
    # Distance-to-nearest-corner alpha mask. Applied after any border paint so
    # the border and video share the same rounded outer silhouette.
    return f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(pow(max({r}-min(X,W-1-X),0),2)+pow(max({r}-min(Y,H-1-Y),0),2),pow({r},2)),255,0)'"

def apply_layers(base,p,root,work,slug,out):
    W=int(p['canvas']['width']);H=int(p['canvas']['height']);fps=int(p.get('fps',30));media=p['media']; total=float(p['duration'])
    extra=[]
    for ti,t in enumerate(p['tracks']):
        if t.get('kind') in ('main','audio') or t.get('id')=='visual': continue
        for c in t.get('clips',[]): extra.append((ti,t,c))
    if not extra:
        run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',base,'-c','copy',out]); return
    cmd=['ffmpeg','-hide_banner','-loglevel','error','-y','-i',base]; filters=[]; cur='0:v'; input_idx=1; layer_n=0
    def z_key(item):
        ti,t,_=item
        short=str(t.get('short') or '')
        # FableCut exposes video tracks top-to-bottom as V4,V3,V2,V1.
        # Composite bottom-to-top so the numerically higher track is visually above.
        if len(short)>1 and short[0].upper()=='V' and short[1:].isdigit():
            return (0,int(short[1:]))
        return (1,ti)
    for ti,t,c in sorted(extra,key=z_key):
        s=float(c['start']);e=float(c['end']);d=max(.05,e-s); kind=t.get('kind','overlay'); l={'main':{'x':0,'y':0,'w':100,'h':100},'presenter':{'x':70,'y':66,'w':26,'h':28},'overlay':{'x':55,'y':8,'w':40,'h':36},'graphics':{'x':10,'y':10,'w':80,'h':18}}.get(kind,{'x':55,'y':8,'w':40,'h':36}); l={**l,**c.get('layout',{})}; x=int(W*float(l.get('x',0))/100);y=int(H*float(l.get('y',0))/100);tw=max(2,int(W*float(l.get('w',40))/100));th=max(2,int(H*float(l.get('h',36))/100)); en=f"between(t,{s:.3f},{e:.3f})"
        if c.get('type')=='text':
            st=c.get('textStyle',{}); txt=esc_text(c.get('text','Text')); fs=int(st.get('fontSize',48)); color=st.get('color','#ffffff'); bg=st.get('background','#000000'); align=st.get('align','center'); tx=x+10 if align=='left' else x+tw-10 if align=='right' else x+tw/2; exprx=f'{tx}-text_w' if align=='right' else str(tx) if align=='left' else f'{tx}-text_w/2'; ty=f'{y}+({th}-text_h)/2'; nxt=f'c{layer_n}';filters.append(f"[{cur}]drawtext=text='{txt}':x={exprx}:y={ty}:fontsize={fs}:fontcolor={color}:box=1:boxcolor={bg}@0.65:boxborderw=12:enable='{en}'[{nxt}]");cur=nxt;layer_n+=1;continue
        if c.get('type')=='shape':
            ss=c.get('shapeStyle',{});fill=ss.get('fill','#5be066');stroke=ss.get('stroke','#5be066');sw=int(ss.get('strokeWidth',4));nxt=f'c{layer_n}';filters.append(f"[{cur}]drawbox=x={x}:y={y}:w={tw}:h={th}:color={fill}@0.22:t=fill:enable='{en}',drawbox=x={x}:y={y}:w={tw}:h={th}:color={stroke}@0.95:t={max(1,sw)}:enable='{en}'[{nxt}]");cur=nxt;layer_n+=1;continue
        aid=c.get('asset');a=media.get(aid);path=asset_path(root,work,slug,aid,media)
        if a.get('type')=='video': cmd+=['-ss',f'{float(c.get("sourceIn",0)):.3f}','-t',f'{d:.3f}','-i',path]
        else: cmd+=['-loop','1','-framerate',str(fps),'-t',f'{d:.3f}','-i',path]
        raw=f'r{layer_n}'; chain=f'[{input_idx}:v]setpts=PTS-STARTPTS+{s:.3f}/TB,fps={fps}'
        if aid=='product':
            cr=a.get('crop',{});top=int(cr.get('top',110));bot=int(cr.get('bottom',100));chain+=f',crop=iw:ih-{top+bot}:0:{top}'
        else:
            chain+=percent_crop_filter(c)
        fit=c.get('fit','cover'); radius=max(0,float(l.get('radius',0) or 0)); bd=max(0,int(l.get('border',0) or 0))
        # Rounded clips are frame elements (PiP), so fill the requested box after
        # FableCut crop instead of reintroducing transparent letterboxing.
        if fit=='contain' and radius>0:chain+=f',scale={tw}:{th}:force_original_aspect_ratio=increase,crop={tw}:{th},format=rgba'
        elif fit=='contain':chain+=f',scale={tw}:{th}:force_original_aspect_ratio=decrease,pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba'
        elif fit=='fill':chain+=f',scale={tw}:{th},format=rgba'
        else:chain+=f',scale={tw}:{th}:force_original_aspect_ratio=increase,crop={tw}:{th},format=rgba'
        if radius>0:
            if bd>0: chain+=f",drawbox=x=0:y=0:w=iw:h=ih:color={c.get('borderColor','#ffffff')}:t={bd}"
            chain+=','+rounded_alpha(min(radius,min(tw,th)/2))
        op=max(0,min(1,float(c.get('opacity',1))));chain+=f',colorchannelmixer=aa={op:.3f}'
        td=max(.05,float(c.get('transitionDuration',.35)))
        if c.get('transitionIn')=='fade':chain+=f',fade=t=in:st=0:d={min(td,d):.3f}:alpha=1'
        if c.get('transitionOut')=='fade':chain+=f',fade=t=out:st={max(0,d-min(td,d)):.3f}:d={min(td,d):.3f}:alpha=1'
        rot=float(l.get('rotate',0));scale=float(l.get('scale',1))
        if abs(scale-1)>.001: chain+=f',scale=iw*{scale:.4f}:ih*{scale:.4f}'
        if abs(rot)>.01: chain+=f',rotate={rot}*PI/180:ow=rotw(iw):oh=roth(ih):c=none'
        chain+=f'[{raw}]';filters.append(chain);nxt=f'c{layer_n}';filters.append(f"[{cur}][{raw}]overlay={x}:{y}:eof_action=pass:shortest=0:enable='{en}'[{nxt}]");cur=nxt;layer_n+=1;input_idx+=1
        # Non-rounded legacy overlays keep their rectangular border. Rounded
        # overlays paint the border before the alpha mask above.
        if bd>0 and radius<=0:
            nxt=f'cb{layer_n}'; filters.append(f"[{cur}]drawbox=x={x}:y={y}:w={tw}:h={th}:color={c.get('borderColor','#ffffff')}:t={bd}:enable='{en}'[{nxt}]");cur=nxt;layer_n+=1
    filters.append(f'[{cur}]format=yuv420p[v]');cmd+=['-filter_complex',';'.join(filters),'-map','[v]','-an','-t',f'{total:.3f}','-c:v','libx264','-preset','medium','-crf','17','-pix_fmt','yuv420p',out];run(cmd)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--project',required=True);ap.add_argument('--work',default='work');ap.add_argument('--out',required=True);args=ap.parse_args()
    root=Path.cwd();p=json.loads(Path(args.project).read_text());work=Path(args.work);slug=p['slug'];presenter=work/'presenter.mp4';product=work/'product.mp4';w=int(p['canvas']['width']);h=int(p['canvas']['height']);fps=int(p.get('fps',30));total=float(p['duration']);media=p['media'];pip=p.get('pip',{})
    main_track=next((t for t in p['tracks'] if t.get('kind')=='main'),None) or next((t for t in p['tracks'] if t.get('id')=='visual'),None)
    if not main_track:raise ValueError('No main visual track')
    paths={k:asset_path(root,work,slug,k,media) for k in media}
    for k,v in paths.items():
        if not v.exists():raise FileNotFoundError(v)
    has_presenter_track=any(t.get('kind')=='presenter' and t.get('clips') for t in p['tracks'])
    clips=sorted(main_track['clips'],key=lambda c:c['start']);expected=0.0
    background=p.get('background') or '#f4f0e7'
    with tempfile.TemporaryDirectory(prefix='qserve-editor-render-') as tmp:
        td=Path(tmp);segs=[];seq=0
        for c in clips:
            s=float(c['start']);e=float(c['end']);d=e-s
            if s < expected-.08:raise ValueError(f'Overlap before {c["id"]}: expected at least {expected:.3f}, got {s:.3f}')
            if s > expected+.001:
                gap=td/f'{seq:03d}.mp4';seq+=1
                render_gap(gap,s-expected,w,h,fps,background);segs.append(gap)
            if d<=0:raise ValueError(f'Bad duration: {c["id"]}')
            aid=c['asset'];out=td/f'{seq:03d}.mp4';seq+=1;legacy=bool(c.get('pip')) and not has_presenter_track
            if aid=='presenter':render_presenter(paths[aid],float(c.get('sourceIn',s)),d,out,w,h,fps,c)
            elif aid=='product':render_product(paths[aid],presenter,s,float(c.get('sourceIn',0)),d,out,w,h,fps,pip,media[aid],c,legacy)
            else:render_image(paths[aid],presenter,s,d,out,w,h,fps,pip,c,legacy)
            segs.append(out);expected=e
        if expected > total+.08:raise ValueError(f'Timeline ends at {expected:.3f}, expected {total:.3f}')
        if total > expected+.001:
            gap=td/f'{seq:03d}.mp4'
            render_gap(gap,total-expected,w,h,fps,background);segs.append(gap)
        concat=td/'concat.txt';concat.write_text('\n'.join(f"file '{x.as_posix()}'" for x in segs)+'\n');base=td/'base.mp4';run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',concat,'-c','copy',base])
        layered=td/'layered.mp4';apply_layers(base,p,root,work,slug,layered)
        output=Path(args.out);output.parent.mkdir(parents=True,exist_ok=True);ff=(f'[0:v]tpad=stop_mode=clone:stop_duration=1.0,fps={fps},format=yuv420p[v];[1:a]apad=pad_dur=1.0[a]')
        run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',layered,'-i',presenter,'-filter_complex',ff,'-map','[v]','-map','[a]','-c:v','libx264','-preset','medium','-crf','17','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-t',f'{total:.3f}','-movflags','+faststart',output])
    print(f'Rendered {output}')
if __name__=='__main__':main()
