// The worldline (a Catmull–Rom ribbon through the memories in date order) and autonav
// (the camera ride along it). CameraRig mounts both; other canvases can mount <Worldline/>.
export { Worldline, type WorldlineProps } from './Worldline.tsx'
export { AutonavRig, exitAutonav, type AutonavRigProps } from './AutonavRig.tsx'
export { AutonavRide, AUTONAV_DEFAULTS, dampFactor, type AutonavOptions } from './autonav.ts'
export { refreshWorldline, currentWorldline } from './live.ts'
export { WorldlinePath, catmullRom, memoryOrder, sampleCount, knotsFromPoses, SAMPLES_PER_SEGMENT } from './path.ts'
