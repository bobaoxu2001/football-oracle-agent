# Ridge Dixon-Coles backtest — results through 2026-09-10

_Auto-generated nightly by `dc_model.py`. Do not edit by hand._

```
======================================================================
  RIDGE DIXON-COLES — fit + leave-one-out backtest
======================================================================
Matches fit on .......... 102
Teams ................... 48
Ridge k (LOO-tuned) ..... 4.000
Home advantage (γ) ...... +0.503   (log-goals; hosts only)
Baseline μ0 ............. +0.237   →  1.27 goals/side neutral
Dixon-Coles ρ ........... -0.180   (low-score dependence)

-- LEAVE-ONE-OUT METRICS (out-of-sample) ---------------------------
RPS      0.188   vs uniform 0.239   (skill +21.0%)
Brier    0.560   vs uniform 0.667   (skill +16.1%)
LogLoss  0.943   vs uniform 1.099
Top-pick accuracy ....... 58.8%   (decisive only 71.8%)

-- CALIBRATION (pooled LOO 1X2 outcomes) ---------------------------
  bucket      n   mean_pred  observed   gap
  00-20%     62       14%       13%      -1%
  20-40%    169       30%       27%      -3%
  40-60%     46       50%       61%     +11%
  60-80%     25       67%       68%      +1%
  80-100%     4       87%       75%     -12%
  ECE: 3.6%

-- RIDGE TUNING (LOO log-loss by k) --------------------------------
  k=0.25   logloss 1.097   rps 0.199  
  k=0.5    logloss 1.035   rps 0.194  
  k=1.0    logloss 0.982   rps 0.189  
  k=2.0    logloss 0.949   rps 0.187  
  k=4.0    logloss 0.943   rps 0.188 *
  k=8.0    logloss 0.962   rps 0.195  

-- TEAM STRENGTH (net = attack + defence, full-data fit) -----------
  (att ↑ = scores more · def ↑ = concedes less)
  Strongest:
    Spain                  net +1.23  (att +0.38, def +0.86)
    France                 net +0.97  (att +0.42, def +0.55)
    Argentina              net +0.80  (att +0.58, def +0.23)
    Belgium                net +0.67  (att +0.44, def +0.22)
    England                net +0.61  (att +0.42, def +0.19)
  Weakest:
    Qatar                  net -0.79  (att -0.23, def -0.56)
    Curaçao                net -0.87  (att -0.34, def -0.53)
    Uzbekistan             net -0.87  (att -0.11, def -0.76)
    Iraq                   net -0.91  (att -0.38, def -0.53)
    Tunisia                net -0.94  (att -0.28, def -0.66)
```
