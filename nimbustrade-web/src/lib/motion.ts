/** Cap stagger delay so a large grid doesn't feel sluggish by its last item. */
export function staggerDelay(index: number, step = 0.06, max = 0.3) {
  return Math.min(index * step, max);
}
