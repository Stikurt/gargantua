from PIL import Image, ImageDraw
for size in (192,512):
    im=Image.new('RGB',(size,size),'#183b32')
    d=ImageDraw.Draw(im)
    s=size/192
    def line(points,width=7):d.line([(int(x*s),int(y*s)) for x,y in points],fill='#e5c992',width=max(1,int(width*s)),joint='curve')
    line([(40,49),(84,49),(96,61),(108,49),(152,49),(152,140),(108,140),(96,150),(84,140),(40,140),(40,49)])
    line([(96,61),(96,146)],5)
    for a,b in [(54,81),(111,138)]:
        for y in (74,91,108):line([(a,y),(b,y)],4)
    im.save(f'/out/icon-{size}.png')
