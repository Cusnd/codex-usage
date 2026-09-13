import type { ComponentProps } from 'react';
import { Bar } from 'recharts';
import { usePlotMotion, type PlotMotion } from './ChartMotion.js';
import { motion } from './motion.js';

// Only the analysis route needs Bar; overview's Area must not eagerly import it.
export function MotionBar({ change, series, points, ...props }: Omit<ComponentProps<typeof Bar>, keyof PlotMotion> & PlotMotion) {
  const plot = usePlotMotion({ change, series, points });
  return <g ref={plot.ref} data-chart-transition={plot.kind}>
    <Bar {...props} className={`${props.className || ''} ${plot.layer}`} isAnimationActive={plot.active} animationDuration={motion.chart} animationEasing="ease-out"
      onAnimationStart={plot.start} onAnimationEnd={plot.end} />
  </g>;
}
