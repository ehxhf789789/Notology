// Design tokens — Motion (easing, duration, presets)

export const motion = {
  ease: {
    default: 'cubic-bezier(0.25, 0.1, 0.25, 1.0)',
    out:     'cubic-bezier(0.16, 1, 0.3, 1)',
    in:      'cubic-bezier(0.4, 0, 1, 0.5)',
    inOut:   'cubic-bezier(0.42, 0, 0.58, 1)',
    spring:  'cubic-bezier(0.34, 1.56, 0.64, 1)',
    bounce:  'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  },
  duration: {
    instant: '80ms',
    fast:    '150ms',
    normal:  '250ms',
    slow:    '400ms',
    slower:  '600ms',
  },
  transition: {
    color:     'color 150ms ease, background-color 150ms ease',
    transform: 'transform 250ms cubic-bezier(0.16, 1, 0.3, 1)',
    opacity:   'opacity 200ms ease',
    shadow:    'box-shadow 200ms ease',
    width:     'width 300ms cubic-bezier(0.42, 0, 0.58, 1)',
    all:       'all 250ms cubic-bezier(0.25, 0.1, 0.25, 1.0)',
  },
} as const;
