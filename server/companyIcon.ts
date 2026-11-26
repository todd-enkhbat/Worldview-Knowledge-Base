import { sniffImageMime } from '../src/data/attachments.ts'

/** Retained organization artwork must be a renderable raster. Keep vector input out of the renderer. */
export async function rasterCompanyIcon(bytes:Uint8Array):Promise<Uint8Array> {
  if(sniffImageMime(bytes.subarray(0,4096))) return bytes
  const b=Buffer.from(bytes)
  if(b.length>=22 && b.readUInt32LE(0)===65536) {
    const n=b.readUInt16LE(4)
    const frames=[]
    for(let i=0;i<Math.min(n,64) && 22+16*i<=b.length;i++) {
      const p=6+16*i, offset=b.readUInt32LE(p+12), size=b.readUInt32LE(p+8)
      if(offset+size<=b.length)frames.push({frame:b.subarray(offset,offset+size),w:b[p]||256,h:b[p+1]||256})
    }
    for(const {frame,w,h} of frames.sort((a,c)=>c.w-a.w)){
      if(sniffImageMime(frame.subarray(0,4096))==='image/png') return frame
      if(frame.length<40 || frame.readUInt32LE(0)!==40 || frame.readInt32LE(4)!==w || frame.readInt32LE(8)!==2*h || frame.readUInt16LE(14)!==32 || frame.readUInt32LE(16)!==0 || frame.length<40+w*h*4) continue
      const rgba=Buffer.alloc(w*h*4), stride=Math.ceil(w/32)*4
      const alpha=frame.subarray(40,40+w*h*4).some((v,i)=>i%4===3 && v!==0)
      for(let y=0;y<h;y++) for(let x=0;x<w;x++){
        const j=((h-1-y)*w+x)*4+40, k=(y*w+x)*4, mask=frame[40+w*h*4+(h-1-y)*stride+(x>>3)]||0
        rgba[k]=frame[j+2];rgba[k+1]=frame[j+1];rgba[k+2]=frame[j];rgba[k+3]=alpha?frame[j+3]:(mask & (128>>(x%8)) ? 0:255)
      }
      const {default:sharp}=await import('sharp')
      return sharp(rgba,{raw:{width:w,height:h,channels:4}}).png().toBuffer()
    }
  }
  if(b.length<=512000) {
    const source=b.toString('utf8').trim()
    if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source) && !/<!DOCTYPE|<!ENTITY|<script\b|<image\b|<foreignObject|@import|\b(?:href|src)\s*=\s*["'](?!#)|url\(\s*["']?(?![#"'\s])/i.test(source)){
      const {default:sharp}=await import('sharp')
      return sharp(b,{limitInputPixels:16000000}).resize(256,256,{fit:'inside'}).png().toBuffer()
    }
  }
  return bytes
}
