(() => {
  const assetBase = new URL('.', document.currentScript.src)
  const frontUrl = new URL('enki-model-front.webp', assetBase).href
  const plateUrls = ['front','back','left','right'].map(side => new URL('enki-model-' + side + '.webp', assetBase).href)
  const radians = Math.PI / 180
  const clamp = value => Math.max(-1, Math.min(1, value))

  const vertexShader = `#version 300 es
    in vec3 position;
    in vec2 texcoord;
    in vec3 projection;
    uniform vec3 angles;
    uniform vec2 fit;
    uniform vec4 gesture;
    out vec2 uv;
    out vec3 sideUv;
    out vec3 local;
    out vec3 surface;
    mat2 rotate(float a) {
      float c = cos(a), s = sin(a);
      return mat2(c, s, -s, c);
    }
    void main() {
      vec3 p = position;
      vec2 wrist = vec2(.585, -.15);
      float arm = smoothstep(.54, .70, p.x) * smoothstep(-.17, .005, p.y)
        * (1.0 - smoothstep(.19, .30, p.y));
      p.xy = wrist + rotate(gesture.x * arm) * (p.xy - wrist);
      // The cord follows the cap after each jump or wave, pinned at the gold band.
      vec2 knot = vec2(.45, .765);
      float cord = smoothstep(.385, .465, p.x) * smoothstep(.47, .56, p.y)
        * (1.0 - smoothstep(.72, .79, p.y));
      p.xy = knot + rotate(gesture.w * cord) * (p.xy - knot);
      // Scale from the feet so anticipation and landing keep ground contact.
      p.x *= 1.0 - gesture.z * .55;
      p.y = -.95 + (p.y + .95) * (1.0 + gesture.z) + gesture.y;
      p.xz = rotate(angles.x) * p.xz;
      p.yz = rotate(angles.y) * p.yz;
      p.xy = rotate(angles.z) * p.xy;
      uv = texcoord;
      sideUv = projection;
      local = position;
      surface = p;
      gl_Position = vec4(p.xy * fit, -p.z * .62, 1.0);
    }`
  const fragmentShader = `#version 300 es
    precision highp float;
    uniform sampler2D frontMap;
    uniform sampler2D backMap;
    uniform sampler2D leftMap;
    uniform sampler2D rightMap;
    uniform vec4 viewWeights;
    uniform float sideLight;
    uniform sampler2D lidMap;
    uniform vec2 expression;
    in vec2 uv;
    in vec3 sideUv;
    in vec3 local;
    in vec3 surface;
    out vec4 color;
    vec3 facePaint() {
      vec3 original = texture(frontMap, uv).rgb;
      if (expression.x <= .001) return original;
      vec4 skin = texture(lidMap, uv);
      if (skin.a <= .001) return original;
      vec2 pixel = uv * vec2(400.0, 383.0);
      bool left = pixel.x < 200.0;
      float across = (pixel.x - (left ? 152.0 : 251.0)) / (left ? 26.0 : 24.0);
      float lidY = (left ? 190.5 : 181.4) - 4.8 * across * across + (left ? .8 : -1.0) * across;
      float opening = max(.03,1.0-expression.x);
      vec2 sampled = vec2(uv.x, (lidY + (pixel.y - lidY) / opening) / 383.0);
      vec3 shrinking = mix(skin.rgb,texture(frontMap,sampled).rgb,texture(lidMap,sampled).a);
      float taper = max(0.0, 1.0 - pow(abs(across), 3.0));
      float lash = (1.0 - smoothstep(1.55*taper, 1.55*taper + .9, abs(pixel.y-lidY)))
        * (1.0 - smoothstep(.83,1.08,abs(across)));
      vec3 closed = mix(skin.rgb,vec3(.23,.115,.073),lash);
      return mix(original,mix(shrinking,closed,smoothstep(.78,.98,expression.x)),skin.a);
    }
    void main() {
      vec3 localNormal = normalize(cross(dFdx(local), dFdy(local)));
      // View-dependent texture projection retains details around the cheeks and locks.
      vec4 alignment = max(vec4(localNormal.z, -localNormal.z, localNormal.x, -localNormal.x), vec4(0.0));
      vec4 w = viewWeights * (.025 + alignment * alignment * alignment);
      w /= max(.0001, dot(w,vec4(1.0)));
      vec3 paint = w.x * facePaint()
        + w.y * texture(backMap,vec2(sideUv.x,uv.y)).rgb
        + w.z * texture(leftMap,vec2(sideUv.y,uv.y)).rgb
        + w.w * texture(rightMap,vec2(sideUv.z,uv.y)).rgb;
      vec3 n = normalize(cross(dFdx(surface), dFdy(surface)));
      float turningLight = .84 + .16 * max(0.0, dot(n, normalize(vec3(-.35,.6,.75))));
      float accent = smoothstep(.86,.90,uv.x) * (1.0 - smoothstep(.43,.47,uv.y));
      paint = mix(paint,vec3(1.0,.93,.68),accent * expression.y * .6);
      color = vec4(paint * mix(1.0, turningLight, sideLight), 1.0);
    }`

  async function loadTexture(url) {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  }

  function padTexture(image) {
    // UV islands can border each other at a grazing angle. Extend their edge
    // colors into transparent texels so filtering never picks up a blank seam.
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', {willReadFrequently:true})
    context.drawImage(image,0,0)
    const pixels = context.getImageData(0,0,canvas.width,canvas.height)
    const rgba = pixels.data, count = rgba.length/4
    const queue = new Uint32Array(count), visited = new Uint8Array(count)
    let head = 0, tail = 0
    for (let i = 0; i < count; i++) {
      if (rgba[i*4+3] >= 215) { visited[i] = 1; queue[tail++] = i }
    }
    function extend(from, to) {
      if (visited[to]) return
      visited[to] = 1
      const a = from*4, b = to*4
      rgba[b] = rgba[a]; rgba[b+1] = rgba[a+1]; rgba[b+2] = rgba[a+2]
      queue[tail++] = to
    }
    while (head < tail) {
      const i = queue[head++], x = i%canvas.width
      if (x > 0) extend(i,i-1)
      if (x < canvas.width-1) extend(i,i+1)
      if (i >= canvas.width) extend(i,i-canvas.width)
      if (i < count-canvas.width) extend(i,i+canvas.width)
      rgba[i*4+3] = 255
    }
    context.putImageData(pixels,0,0)
    return canvas
  }

  // The lid material borrows skin tones from the same cheek. Restrict the
  // mask to the eye sockets so the eyebrows and bangs stay still during a blink.
  function eyelidMaterial(image) {
    const canvas = document.createElement('canvas')
    canvas.width = 400
    canvas.height = 383
    const context = canvas.getContext('2d', {willReadFrequently:true})
    context.drawImage(image,0,0,400,383)
    const original = context.getImageData(0,0,400,383).data
    context.clearRect(0,0,400,383)
    const sockets = [
      [[119,185],[126,176],[132,170],[143,165],[164,165],[177,171],[183,180],[183,201],[173,210],[149,211],[135,201],[119,195]],
      [[222,170],[228,158],[244,154],[262,151],[275,156],[281,166],[270,180],[263,190],[254,199],[236,201],[225,193]],
    ]
    for (const socket of sockets) {
      context.beginPath()
      for (const [x,y] of socket) context.lineTo(x,y)
      context.closePath()
      context.fill()
    }
    const material = context.getImageData(0,0,400,383)
    const mask = material.data
    const directions = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]
    for (let y = 150; y < 212; y++) {
      for (let x = 118; x < 282; x++) {
        const i = (y*400+x)*4
        if (!mask[i+3]) continue
        let r = 0, g = 0, b = 0, weights = 0
        for (const [dx,dy] of directions) {
          for (let distance = 1; distance <= 48; distance++) {
            const index = ((y+dy*distance)*400 + x+dx*distance)*4
            if (mask[index+3] || original[index] < 184 || original[index+1] < 133) continue
            const weight = 1 / ((dx*dx+dy*dy)*distance*distance)
            r += original[index]*weight; g += original[index+1]*weight; b += original[index+2]*weight
            weights += weight
            break
          }
        }
        if (weights) {
          mask[i] = r/weights; mask[i+1] = g/weights; mask[i+2] = b/weights
        } else mask[i+3] = 0
      }
    }
    context.putImageData(material,0,0)
    return canvas
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = new Error(gl.getShaderInfoLog(shader))
      gl.deleteShader(shader)
      throw error
    }
    return shader
  }

  function createScene(gl, mesh, images) {
    const program = gl.createProgram()
    const shaders = [], buffers = [], textures = []
    function dispose() {
      for (const buffer of buffers) gl.deleteBuffer(buffer)
      for (const texture of textures) gl.deleteTexture(texture)
      for (const shader of shaders) gl.deleteShader(shader)
      gl.deleteProgram(program)
    }
    try {
      shaders.push(compile(gl, gl.VERTEX_SHADER, vertexShader))
      shaders.push(compile(gl, gl.FRAGMENT_SHADER, fragmentShader))
      for (const shader of shaders) gl.attachShader(program, shader)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program))
      gl.useProgram(program)
      function upload(target, data) {
        const buffer = gl.createBuffer()
        buffers.push(buffer)
        gl.bindBuffer(target, buffer)
        gl.bufferData(target, data, gl.STATIC_DRAW)
      }
      upload(gl.ARRAY_BUFFER, mesh.vertices)
      for (const [name, size, offset] of [['position',3,0], ['texcoord',2,12], ['projection',3,20]]) {
        const location = gl.getAttribLocation(program,name)
        gl.enableVertexAttribArray(location)
        gl.vertexAttribPointer(location,size,gl.FLOAT,false,32,offset)
      }
      upload(gl.ELEMENT_ARRAY_BUFFER, mesh.indices)
      const maps = [...images.map(padTexture),eyelidMaterial(images[0])]
      maps.forEach((map, i) => {
        const texture = gl.createTexture()
        textures.push(texture)
        gl.activeTexture(gl.TEXTURE0 + i)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, map)
        gl.generateMipmap(gl.TEXTURE_2D)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
        gl.uniform1i(gl.getUniformLocation(program, ['frontMap','backMap','leftMap','rightMap','lidMap'][i]), i)
      })
      gl.enable(gl.DEPTH_TEST)
      gl.clearColor(0,0,0,0)
      const uniform = Object.fromEntries(['angles','fit','gesture','expression','sideLight','viewWeights'].map(name => [name,gl.getUniformLocation(program,name)]))
      return {
        draw(yaw, pitch, roll, pose) {
          const { width, height } = gl.canvas
          gl.viewport(0,0,width,height)
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
          gl.uniform2f(uniform.fit,.93 * Math.min(1,height/width),.93 * Math.min(1,width/height))
          gl.uniform3f(uniform.angles,yaw,pitch,roll)
          gl.uniform4f(uniform.gesture,pose.wave,pose.lift,pose.stretch,pose.tassel)
          gl.uniform2f(uniform.expression,pose.blink,pose.glint)
          const cos = Math.cos(yaw), sin = Math.sin(yaw)
          gl.uniform4fv(uniform.viewWeights,[cos,-cos,sin,-sin].map(a => Math.max(0,a) ** 6))
          gl.uniform1f(uniform.sideLight,Math.abs(sin) * .6)
          gl.drawElements(gl.TRIANGLES,mesh.indices.length,gl.UNSIGNED_SHORT,0)
        }, dispose,
      }
    } catch (error) {
      dispose()
      throw error
    }
  }

  const durations = { blink:230, breathe:1100, greet:820, celebrate:1020 }
  const rest = { wave:0, lift:0, stretch:0, tassel:0, blink:0, glint:0, tilt:0, nod:0 }

  function pulse(time,start,duration) {
    const t = (time-start)/duration
    return t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI*t) ** 2
  }

  function blinkAt(time) {
    if (time < 0 || time >= durations.blink) return 0
    if (time < 76) return Math.sin(time/76 * Math.PI/2)
    if (time < 116) return 1
    return Math.cos((time-116)/114 * Math.PI/2) ** 2
  }

  function poseAt(action, time) {
    if (!action || time < 0 || time >= durations[action]) return rest
    const pose = {...rest}
    if (action === 'blink' || action === 'breathe') {
      pose.blink = blinkAt(time - (action === 'breathe' ? 450 : 0))
      if (action === 'breathe') {
        const breath = pulse(time,0,durations.breathe)
        pose.stretch = .018*breath
        pose.nod = -.045*breath
      }
      return pose
    }
    const joy = action === 'celebrate'
    const waveStart = joy ? 155 : 0
    const waveEnvelope = pulse(time,waveStart,650)
    const phase = (time-waveStart)/650 * Math.PI*4
    pose.wave = waveEnvelope * (.17 + .46*Math.sin(phase))
    pose.tassel = .19*pulse(time,waveStart+65,700) * Math.sin(phase-.9)
    pose.tilt = (joy ? -.095 : -.065) * pulse(time,0,joy ? 920 : 740)
    pose.blink = blinkAt(time - (joy ? 280 : 490))
    pose.glint = pulse(time,waveStart+85,230) + pulse(time,waveStart+360,240)
    if (joy) {
      const flight = Math.max(0,Math.min(1,(time-150)/440))
      const jump = 4*flight*(1-flight)
      pose.lift = .094*jump
      pose.stretch = -.064*pulse(time,0,150) + .014*jump - .045*pulse(time,565,195)
      pose.nod = -.075*jump + .045*pulse(time,560,210)
    }
    return pose
  }

  function mount(canvas) {
    let scene, active = true, disposed = false, generation = 0
    let frame = 0, timer = 0, angle = 0, pitch = 0, aimX = 0, aimY = 0, turn = 0
    let action = null, started = 0, previous = 0, idleCount = 0, roll = 0
    const hover = matchMedia('(hover: hover) and (pointer: fine)')
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const artwork = Promise.all(plateUrls.map(loadTexture))
    const portrait = new Image()
    portrait.src = frontUrl
    portrait.alt = ''
    portrait.style.position = 'absolute'
    portrait.style.inset = '5%'
    portrait.style.width = portrait.style.height = '90%'
    portrait.style.objectFit = 'contain'
    portrait.style.pointerEvents = 'none'
    canvas.after(portrait)
    let sculpted
    function fallback() {
      canvas.dataset.modelState = 'illustration'
      canvas.style.visibility = 'hidden'
      portrait.hidden = false
    }
    fallback()

    function draw(now) {
      frame = 0
      if (!active || disposed || !scene || document.hidden) return
      // A small desktop figure gains little from redrawing at 120 Hz.
      if (!motion.matches && now - previous < 15.5) { schedule(); return }
      const rect = canvas.getBoundingClientRect()
      const scale = Math.min(window.devicePixelRatio || 1, 2.5)
      const w = Math.max(1, Math.round(rect.width*scale)), h = Math.max(1, Math.round(rect.height*scale))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const elapsed = Math.max(1, Math.min(150, now-previous))
      previous = now
      const fraction = motion.matches ? 1 : 1-Math.exp(-elapsed/72)
      const following = !motion.matches && hover.matches
      const targetAngle = turn + (following ? aimX * .21 : 0)
      const targetPitch = following ? aimY * -.10 : 0
      const targetRoll = following ? aimX * -.085 : 0
      angle += (targetAngle-angle) * fraction
      pitch += (targetPitch-pitch) * fraction
      roll += (targetRoll-roll) * fraction
      const pose = poseAt(action,Math.max(0,now-started))
      scene.draw(angle,pitch+pose.nod,roll+pose.tilt,pose)
      const moving = Math.abs(targetAngle-angle) + Math.abs(targetPitch-pitch) + Math.abs(targetRoll-roll) > .0005
      if (pose !== rest || moving) schedule()
      else {
        action = null
        if (!motion.matches && !timer) {
          timer = setTimeout(() => {
            timer = 0
            idleCount++
            play(idleCount % 3 === 0 ? 'breathe' : 'blink')
          }, 4500 + Math.random()*4200)
        }
      }
    }
    function schedule() {
      if (!frame && active && !disposed && !document.hidden) frame = requestAnimationFrame(draw)
    }
    function stop() {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      frame = timer = 0
    }
    function play(name) {
      if (motion.matches || !active || disposed || document.hidden) return
      // One reaction at a time. Finishing a task can interrupt an idle greeting.
      if (action === 'celebrate' || (action === 'greet' && name === 'greet')) return
      clearTimeout(timer)
      timer = 0
      action = name
      started = performance.now()
      schedule()
    }
    function visibility() { stop(); action = null; if (!document.hidden) schedule() }
    function lost(event) {
      event.preventDefault()
      generation++
      stop()
      scene = undefined
      fallback()
    }
    async function initialize() {
      const ticket = ++generation
      try {
        const images = await artwork
        if (disposed || ticket !== generation) return
        const gl = canvas.getContext('webgl2', { alpha:true, antialias:true, depth:true, powerPreference:'low-power' })
        if (!gl) return
        sculpted ??= window.EnkiSculpture.build(images[0], images[2], images[3])
        scene = createScene(gl,sculpted,images)
        canvas.style.visibility = 'visible'
        portrait.hidden = true
        canvas.dataset.modelState = '3d'
        schedule()
      } catch (error) {
        if (!disposed && ticket === generation) {
          fallback()
          console.warn('Enki portrait fallback', error)
        }
      }
    }
    function motionChanged() { stop(); action = null; schedule() }
    const observer = new ResizeObserver(schedule)
    observer.observe(canvas)
    document.addEventListener('visibilitychange',visibility)
    motion.addEventListener('change',motionChanged)
    canvas.addEventListener('webglcontextlost',lost)
    canvas.addEventListener('webglcontextrestored',initialize)
    initialize()
    return {
      look(x,y) {
        if (!hover.matches || motion.matches) return
        const nextX = clamp(x), nextY = clamp(y)
        if (nextX !== aimX || nextY !== aimY) { aimX = nextX; aimY = nextY; schedule() }
      },
      turn(degrees) { if (Number.isFinite(degrees)) { turn += radians*degrees; schedule() } },
      reset() { turn = Math.round(angle / (Math.PI * 2)) * Math.PI * 2; aimX = aimY = 0; schedule() },
      greet() { play('greet') },
      celebrate() { play('celebrate') },
      setActive(value) { active = Boolean(value); stop(); action = null; if (active) schedule() },
      dispose() {
        disposed = true
        stop()
        observer.disconnect()
        document.removeEventListener('visibilitychange',visibility)
        motion.removeEventListener('change',motionChanged)
        canvas.removeEventListener('webglcontextlost',lost)
        canvas.removeEventListener('webglcontextrestored',initialize)
        portrait.remove()
        scene?.dispose()
      },
    }
  }
  window.EnkiModel = { mount }
})()
