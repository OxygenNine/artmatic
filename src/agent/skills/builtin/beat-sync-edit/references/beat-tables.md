# Beat arithmetic

`beat = 60 / bpm`, `bar = beatsPerBar * beat`, `n16 = beat / 4`, `n8 = beat / 2`.
All times are seconds; multiply by `fps` to get frames, then round to the frame grid.

| BPM | beat | bar (4/4) | 8th | 16th | beat @30fps |
|---|---|---|---|---|---|
| 70 | 0.8571 | 3.4286 | 0.4286 | 0.2143 | 25.71 |
| 80 | 0.7500 | 3.0000 | 0.3750 | 0.1875 | 22.50 |
| 85 | 0.7059 | 2.8235 | 0.3529 | 0.1765 | 21.18 |
| 90 | 0.6667 | 2.6667 | 0.3333 | 0.1667 | 20.00 |
| 95 | 0.6316 | 2.5263 | 0.3158 | 0.1579 | 18.95 |
| 100 | 0.6000 | 2.4000 | 0.3000 | 0.1500 | 18.00 |
| 110 | 0.5455 | 2.1818 | 0.2727 | 0.1364 | 16.36 |
| 120 | 0.5000 | 2.0000 | 0.2500 | 0.1250 | 15.00 |
| 128 | 0.4688 | 1.8750 | 0.2344 | 0.1172 | 14.06 |
| 130 | 0.4615 | 1.8462 | 0.2308 | 0.1154 | 13.85 |
| 140 | 0.4286 | 1.7143 | 0.2143 | 0.1071 | 12.86 |
| 150 | 0.4000 | 1.6000 | 0.2000 | 0.1000 | 12.00 |
| 160 | 0.3750 | 1.5000 | 0.1875 | 0.0938 | 11.25 |
| 170 | 0.3529 | 1.4118 | 0.1765 | 0.0882 | 10.59 |
| 174 | 0.3448 | 1.3793 | 0.1724 | 0.0862 | 10.34 |

At 30 fps one frame is 0.0333 s, so a 16th note at 120 BPM is 3.75 frames — **every
triple-rate accent rounds to a different distance**. Round each timestamp
independently, never accumulate a rounded step.

## Drift from a wrong BPM

Position error after N seconds of music = `N * |bpm_written / bpm_true - 1|`.

| Error | 8 s | 16 s | 32 s | 64 s |
|---|---|---|---|---|
| 0.1 % | 8 ms | 16 ms | 32 ms | 64 ms |
| 0.5 % | 40 ms | 80 ms | 160 ms | 320 ms |
| 1 % | 80 ms | 160 ms | 320 ms | 640 ms |
| 2 % | 160 ms | 320 ms | 640 ms | 1.28 s |

At 30 fps, 100 ms is three frames — already visible at the end of a 16 s section.
One percent is roughly the difference between 120 and 121.2 BPM, which is inside the
noise of any tap-tempo estimate. That is why the grid is estimated once from audio and
then treated as a fact.
