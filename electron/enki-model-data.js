/* The two texture plates share front-view coordinates. The rear plate is mirrored
   on disk so its landmarks follow the same world-space side of the model. */
(() => {
  const columns = 120
  const rows = 116
  const stride = columns + 1
  const width = 400
  const height = 383

  function silhouette(image) {
    const canvas = document.createElement('canvas')
    canvas.width = stride
    canvas.height = rows + 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    // A one-cell transparent border keeps clipped triangles closed at every tip.
    context.drawImage(image, 1, 1, columns - 1, rows - 1)
    const rgba = context.getImageData(0, 0, stride, rows + 1).data
    const alpha = new Float32Array(stride * (rows + 1))
    const spans = []
    for (let y = 0; y <= rows; y++) {
      const bands = []
      let start = -1
      for (let x = 0; x <= columns; x++) {
        const i = y * stride + x
        alpha[i] = rgba[i * 4 + 3] / 255
        if (alpha[i] > 0.5 && start < 0) start = x
        if (alpha[i] <= 0.5 && start >= 0) {
          bands.push({ start: start - 0.45, end: x - 0.55 })
          start = -1
        }
      }
      spans.push(bands)
    }
    return { alpha, spans }
  }

  function edgeDistance(alpha) {
    const distance = Float32Array.from(alpha, a => a > 0.5 ? columns : 0)
    // Chamfer distance gives the depth field a rounded edge along the exact cutout.
    for (const direction of [1, -1]) {
      let y = direction > 0 ? 1 : rows - 1
      for (; y > 0 && y < rows; y += direction) {
        let x = direction > 0 ? 1 : columns - 1
        for (; x > 0 && x < columns; x += direction) {
          const i = y * stride + x
          distance[i] = Math.min(distance[i], distance[i-direction]+1, distance[i-direction*stride]+1,
            distance[i-direction*(stride+1)]+Math.SQRT2, distance[i-direction*(stride-1)]+Math.SQRT2)
        }
      }
    }
    return distance
  }

  const clamp = (x, low = 0, high = 1) => Math.max(low, Math.min(high, x))
  function dome(x, y, cx, cy, rx, ry) {
    return Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2))
  }

  function sculpture(x, y, distance) {
    const edge = radius => Math.sqrt(1 - (1 - clamp(distance / radius)) ** 2)
    const face = dome(x,y,193,179,116,101)
    const body = dome(x,y,188,274,111,91)
    const hair = dome(x,y,185,206,181,147)
    const crown = dome(x,y,166,70,92,55)
    const hairLocks = Math.max(dome(x,y,71,239,68,103), dome(x,y,302,245,63,98))
    const eyes = Math.max(dome(x,y,159,187,20,17), dome(x,y,245,180,19,19))
    const hand = dome(x,y,333,192,27,36)
    const bow = Math.max(dome(x,y,181,262,28,18), dome(x,y,235,256,28,19))
    let front = (18 + Math.max(94 * face, 76 * body, 55 * hairLocks, 57 * crown, 43 * hair)
      + 5 * eyes + 7 * bow + 17 * hand) * edge(45)
    let back = (14 + Math.max(99 * hair, 63 * crown, 67 * body, 34 * hairLocks)) * edge(49)
    let center = -8 * hair

    // The thin mortarboard recedes towards its far edge; the tassel hangs from one corner.
    const capEdge = 117 - x * 0.31
    const board = clamp((capEdge - y) / 15) * clamp((276 - x) / 12)
    const boardPlane = (y + x * 0.31 - 94) * 1.45
    center = center * (1 - board) + board * boardPlane
    front = front * (1 - board) + board * 6 * edge(3)
    back = back * (1 - board) + board * 6 * edge(3)
    if (x > 264 && y < 102) {
      const tassel = clamp((x - 264) / 8)
      center = center * (1 - tassel) - 23 * tassel
      front = front * (1 - tassel) + 8 * edge(7) * tassel
      back = back * (1 - tassel) + 8 * edge(7) * tassel
    }
    // The loose accent marks sit in front of the waving hand.
    if (x > 349 && y < 171) return [43 + 3 * edge(3), 43 - 3 * edge(3)]
    return [center + front, center - back]
  }

  function rearProjection(x, y) {
    // Align the rear cap corner, left lock and feet without warping adjacent scanlines.
    const torso = clamp((y - 108) / 95)
    const foot = clamp((y - 326) / 37)
    const hatOffset = 4 + x * .058
    const hairOffset = (28 - x * .07) * (1 - foot) + 6 * foot
    return clamp((x + hatOffset * (1 - torso) + hairOffset * torso) / width)
  }

  function build(frontImage, leftImage, rightImage) {
    const front = silhouette(frontImage)
    const sides = [silhouette(leftImage), silhouette(rightImage)]
    const distance = edgeDistance(front.alpha)
    const vertices = [], triangles = [], nodes = new Map()
    const uv = (grid, dimension) => clamp((grid - 0.5) / (dimension - 1))
    const limits = Array.from({length: rows + 1}, () => ({ near: -Infinity, far: Infinity }))
    function add(x, y, depth) {
      const u = uv(x, columns), v = uv(y, rows)
      const px = u * width, py = v * height
      const [near, far] = sculpture(px, py, depth * width / columns)
      const index = vertices.length / 8
      const bu = rearProjection(px,py)
      const limit = limits[Math.round(y)]
      limit.near = Math.max(limit.near,near)
      limit.far = Math.min(limit.far,far)
      for (const z of [near,far]) {
        vertices.push((px-190)/200,(192-py)/200,z/200,u,v,bu,0,0)
      }
      return index
    }

    function point(i) {
      if (!nodes.has(i)) nodes.set(i, add(i % stride, Math.floor(i / stride), distance[i]))
      return nodes.get(i)
    }

    const nodeCount = front.alpha.length
    function crossing(i, j) {
      const key = (Math.min(i, j) + 1) * nodeCount + Math.max(i, j)
      if (!nodes.has(key)) {
        const t = (0.5 - front.alpha[i]) / (front.alpha[j] - front.alpha[i])
        const x = (i % stride) * (1 - t) + (j % stride) * t
        const y = Math.floor(i / stride) * (1 - t) + Math.floor(j / stride) * t
        nodes.set(key, add(x,y,0))
      }
      return nodes.get(key)
    }

    function clipTriangle(a, b, c) {
      const corners = [a, b, c], polygon = []
      for (let k = 0; k < 3; k++) {
        const i = corners[k], j = corners[(k + 1) % 3]
        const inside = front.alpha[i] > 0.5
        if (inside) polygon.push(point(i))
        if (inside !== (front.alpha[j] > 0.5)) polygon.push(crossing(i,j))
      }
      for (let k = 1; k + 1 < polygon.length; k++) {
        const [a, b, c] = [polygon[0], polygon[k], polygon[k+1]]
        triangles.push(a,c,b, a+1,b+1,c+1)
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const i = y * stride + x
        clipTriangle(i,i+1,i+stride)
        clipTriangle(i+1,i+stride+1,i+stride)
      }
    }
    // Project side plates using the sculpture's actual depth at each elevation.
    // A small vertical kernel removes subpixel silhouette noise around the brim.
    function projectionAt(row, depth, side) {
      let total = 0, weights = 0
      for (let r = Math.max(0,row-2); r <= Math.min(rows,row+2); r++) {
        const bands = sides[side].spans[r]
        const {near, far} = limits[r]
        if (!bands.length || !Number.isFinite(near)) continue
        const fraction = clamp((near - depth) / Math.max(1,near-far))
        const x = bands[0].start + fraction * (bands.at(-1).end - bands[0].start)
        const weight = 3 - Math.abs(r - row)
        total += weight * uv(x, columns)
        weights += weight
      }
      return weights ? total / weights : .5
    }
    for (let i = 0; i < vertices.length; i += 8) {
      const row = Math.round(vertices[i+4] * (rows-1) + .5)
      const depth = vertices[i+2]*200
      for (let side = 0; side < 2; side++) {
        vertices[i+6+side] = projectionAt(row,depth,side)
      }
      // Shape the crown and hair in profile, where the front drawing gives no
      // depth cue. The two orthographic profile projections are in model space.
      const projectedZ = (.52 - (vertices[i+6] * .7 + vertices[i+7] * .3)) * 1.30
      vertices[i+2] = .12 * vertices[i+2] + .88 * projectedZ
    }
    return { vertices: new Float32Array(vertices), indices: new Uint16Array(triangles) }
  }

  window.EnkiSculpture = { build }
})()
