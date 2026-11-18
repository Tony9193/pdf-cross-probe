// Global optional raster-cache pools, in pixels (RGBA costs about 4 bytes/pixel).
const pools = [0, 24_000_000, 64_000_000]
function createMemoryPolicy() {
  let tier = 1, recovery = 0
  return ({ free, total }) => {
    if (!(Number.isFinite(free) && Number.isFinite(total) && total > 0 && free >= 0 && free <= total)) {
      throw new Error('Invalid system memory sample')
    }
    const ratio = free / total
    const desired = free < 768 * 1024 || ratio < 0.10 ? 0
      : free >= 4 * 1024 ** 2 && ratio >= 0.30 ? 2 : 1
    if (desired <= tier) { tier = desired; recovery = 0 }
    else if (free >= 1024 ** 2 && ratio >= 0.14 && ++recovery >= 3) { tier++; recovery = 0 }
    else if (free < 1024 ** 2 || ratio < 0.14) recovery = 0
    return pools[tier]
  }
}
module.exports = { createMemoryPolicy }
