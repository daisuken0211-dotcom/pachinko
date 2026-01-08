/* Orb Cascade - Prototype (ES6, Canvas + custom physics)
   - Single-file game loop, minimal assets (SVG placeholders loaded as inline strings)
   - Avoids any real-world pachinko terms; follows spec's mechanics at a simple level.
*/

const CANVAS_W = 360;
const CANVAS_H = 640;
const VIRTUAL_W = 720;   // spec virtual coords
const VIRTUAL_H = 1280;
const SCALE_X = CANVAS_W / VIRTUAL_W;
const SCALE_Y = CANVAS_H / VIRTUAL_H;

// Utility
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (seed) => {
  // xorshift32-like deterministic RNG
  let x = seed >>> 0;
  return function() {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 0xFFFFFFFF;
  };
};

// Load config
let CONFIG = null;
fetch('config.json').then(r=>r.json()).then(j=>{ CONFIG = j; startGame(); }).catch(err=>{
  console.error('Failed to load config.json', err);
});

// SVG placeholders (could be external files)
const ASSETS = {
  orb: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#66c2ff"/></radialGradient></defs><circle cx="20" cy="20" r="16" fill="url(#g)"/></svg>`,
  portal_blue: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" rx="20" fill="#0f4f8f"/><text x="80" y="48" font-size="26" font-family="Arial" fill="#fff" text-anchor="middle">Blue</text></svg>`,
  portal_purple: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" rx="20" fill="#6b2b79"/><text x="80" y="48" font-size="26" font-family="Arial" fill="#fff" text-anchor="middle">Purple</text></svg>`,
  portal_gold: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" rx="20" fill="#d29b14"/><text x="80" y="48" font-size="26" font-family="Arial" fill="#fff" text-anchor="middle">Gold</text></svg>`,
  panel: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="20"><rect width="200" height="20" rx="10" fill="#b3c8d9"/></svg>`,
  warp: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#8af0d6"/><circle cx="32" cy="32" r="18" fill="#062b22"/></svg>`,
  gate: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="10"><rect width="120" height="10" fill="#ffd78f"/></svg>`
};

// Simple image creation from SVG string
function svgToImage(svgString) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
  return img;
}

// Main start
function startGame(){
  if(!CONFIG) return;
  // canvas setup
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  // UI elements
  const scoreBox = document.getElementById('scoreBox');
  const shotsBox = document.getElementById('shotsBox');
  const flowBox = document.getElementById('flowBox');
  const fireBtn = document.getElementById('fireBtn');

  // Load images
  const imgs = {};
  for(const k in ASSETS) imgs[k] = svgToImage(ASSETS[k]);

  // Game classes
  class Orb {
    constructor(x,y,vx,vy, id=0){
      this.pos = {x,y};
      this.vel = {x:vx,y:vy};
      this.radius = CONFIG.orbRadius;
      this.gatePassed = new Set();
      this.warpCooldown = 0;
      this.alive = true;
      this.id = id;
    }
    update(dt, board){
      // physics
      this.vel.y += CONFIG.physics.gravity * dt;
      let speed = Math.hypot(this.vel.x, this.vel.y);
      if(speed > CONFIG.physics.v_max) {
        const s = CONFIG.physics.v_max / speed;
        this.vel.x *= s; this.vel.y *= s;
      }
      if(speed < CONFIG.physics.v_min){
        const s = CONFIG.physics.v_min / (speed + 1e-6);
        this.vel.x *= s; this.vel.y *= s;
      }

      // move
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;

      // walls reflect
      if(this.pos.x - this.radius < 0){ this.pos.x = this.radius; this.vel.x = Math.abs(this.vel.x)*0.95; }
      if(this.pos.x + this.radius > VIRTUAL_W){ this.pos.x = VIRTUAL_W - this.radius; this.vel.x = -Math.abs(this.vel.x)*0.95; }
      if(this.pos.y - this.radius < 0){ this.pos.y = this.radius; this.vel.y = Math.abs(this.vel.y)*0.95; }

      // zones
      for(const z of board.zones){
        if(z.contains(this.pos.x,this.pos.y)){
          if(z.type === 'accel'){ this.vel.x *= Math.pow(CONFIG.physics.accelPerFrame, dt*60); this.vel.y *= Math.pow(CONFIG.physics.accelPerFrame, dt*60); }
          if(z.type === 'drag'){ this.vel.x *= Math.pow(CONFIG.physics.dragPerFrame, dt*60); this.vel.y *= Math.pow(CONFIG.physics.dragPerFrame, dt*60); }
        }
      }

      // panels - reflect on line segments
      for(const p of board.panels){
        // circle-line collision and reflection if close and moving toward
        const n = p.normalAtClosest(this.pos);
        if(!n) continue;
        // penetration
        const dist = p.distToPoint(this.pos);
        if(dist <= this.radius + 0.5){
          // reflect velocity across normal
          const v = this.vel;
          const dot = v.x*n.x + v.y*n.y;
          // only if moving toward the panel
          if(dot < 0){
            this.vel.x = (v.x - 2*dot*n.x) * p.restitution;
            this.vel.y = (v.y - 2*dot*n.y) * p.restitution;
            // push out
            this.pos.x += n.x * (this.radius - dist + 0.5);
            this.pos.y += n.y * (this.radius - dist + 0.5);
          }
        }
      }

      // warps
      if(this.warpCooldown > 0) this.warpCooldown -= dt;
      for(const w of board.warps){
        if(w.contains(this.pos.x,this.pos.y) && this.warpCooldown <= 0){
          const other = w.partner;
          if(other){
            this.pos.x = other.x; this.pos.y = other.y;
            this.warpCooldown = CONFIG.warp.cooldown;
            break;
          }
        }
      }

      // gates crossing
      for(const g of board.gates){
        if(g.checkPass(this)){
          if(!this.gatePassed.has(g.id)){
            this.gatePassed.add(g.id);
            board.onGatePassed(g);
          }
        }
      }

      // portals
      for(const p of board.portals){
        if(p.contains(this.pos.x,this.pos.y)){
          this.alive = false;
          board.onPortalEntered(p);
        }
      }

      // out of bounds bottom
      if(this.pos.y - this.radius > VIRTUAL_H + 100){
        this.alive = false;
        board.onMiss(this);
      }
    }
    draw(ctx){
      const sx = this.pos.x * SCALE_X;
      const sy = this.pos.y * SCALE_Y;
      const r = this.radius * SCALE_X;
      // simple draw
      ctx.save();
      ctx.translate(sx, sy);
      ctx.drawImage(imgs.orb, -r, -r, r*2, r*2);
      ctx.restore();
    }
  }

  class Panel {
    constructor(x1,y1,x2,y2, restitution=0.95){
      this.a={x:x1,y:y1}; this.b={x:x2,y:y2}; this.restitution=restitution;
    }
    // distance from point to line segment, and normal toward outside (approx)
    distToPoint(p){
      const ax=this.a.x, ay=this.a.y, bx=this.b.x, by=this.b.y;
      const vx = bx-ax, vy=by-ay;
      const wx = p.x-ax, wy=p.y-ay;
      const l2 = vx*vx+vy*vy;
      let t = (vx*wx+vy*wy)/l2;
      t = Math.max(0, Math.min(1,t));
      const cx = ax + vx*t, cy = ay + vy*t;
      const dx = p.x-cx, dy = p.y-cy;
      return Math.hypot(dx,dy);
    }
    normalAtClosest(p){
      // compute line normal (perp) unit vector pointing from line to point
      const ax=this.a.x, ay=this.a.y, bx=this.b.x, by=this.b.y;
      const vx = bx-ax, vy=by-ay;
      const l2 = vx*vx+vy*vy;
      if(l2 === 0) return null;
      let t = ((p.x-ax)*vx + (p.y-ay)*vy)/l2;
      t = Math.max(0, Math.min(1,t));
      const cx = ax + vx*t, cy = ay + vy*t;
      let nx = p.x - cx, ny = p.y - cy;
      const len = Math.hypot(nx,ny);
      if(len === 0) return null;
      nx /= len; ny /= len;
      return {x:nx, y:ny};
    }
    draw(ctx){
      ctx.save();
      ctx.strokeStyle = 'rgba(179,200,217,0.9)';
      ctx.lineWidth = 6 * SCALE_X;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(this.a.x*SCALE_X, this.a.y*SCALE_Y);
      ctx.lineTo(this.b.x*SCALE_X, this.b.y*SCALE_Y);
      ctx.stroke();
      ctx.restore();
    }
  }

  class Zone {
    constructor(x,y,w,h,type){ this.x=x; this.y=y; this.w=w; this.h=h; this.type=type; }
    contains(px,py){ return px >= this.x && px <= this.x+this.w && py >= this.y && py <= this.y+this.h; }
    draw(ctx){
      ctx.save();
      if(this.type === 'accel') ctx.fillStyle = 'rgba(70,180,120,0.12)';
      else ctx.fillStyle = 'rgba(200,80,80,0.06)';
      ctx.fillRect(this.x*SCALE_X, this.y*SCALE_Y, this.w*SCALE_X, this.h*SCALE_Y);
      ctx.restore();
    }
  }

  class Warp {
    constructor(x,y,r, id){
      this.x=x; this.y=y; this.r=r; this.id=id; this.partner = null;
    }
    contains(px,py){ return (px-this.x)*(px-this.x)+(py-this.y)*(py-this.y) <= (this.r*this.r); }
    draw(ctx){ ctx.save(); ctx.drawImage(imgs.warp, (this.x-this.r)*SCALE_X, (this.y-this.r)*SCALE_Y, this.r*2*SCALE_X, this.r*2*SCALE_Y); ctx.restore(); }
  }

  class Gate {
    constructor(x1,y1,x2,y2, id){
      this.a={x:x1,y:y1}; this.b={x:x2,y:y2}; this.id=id;
    }
    checkPass(orb){
      // simple line-circle intersection test approximated as orb crossing the infinite line and within segment bounds
      const ox = orb.pos.x, oy = orb.pos.y;
      const ax=this.a.x, ay=this.a.y, bx=this.b.x, by=this.b.y;
      const vx = bx-ax, vy = by-ay;
      const wx = ox-ax, wy = oy-ay;
      const l2 = vx*vx+vy*vy;
      if(l2===0) return false;
      let t = (vx*wx+vy*wy)/l2;
      if(t < 0 || t > 1) return false;
      // distance from point to line
      const cx = ax + vx*t, cy = ay + vy*t;
      const dist = Math.hypot(ox-cx, oy-cy);
      return dist <= orb.radius + 2;
    }
    draw(ctx){
      ctx.save();
      ctx.strokeStyle = 'rgba(255,215,143,0.9)';
      ctx.lineWidth = 4 * SCALE_X;
      ctx.beginPath();
      ctx.moveTo(this.a.x*SCALE_X, this.a.y*SCALE_Y);
      ctx.lineTo(this.b.x*SCALE_X, this.b.y*SCALE_Y);
      ctx.stroke();
      ctx.restore();
    }
  }

  class Portal {
    constructor(x,y,w,h, kind){
      this.x=x; this.y=y; this.w=w; this.h=h; this.kind=kind;
    }
    contains(px,py){ return px >= this.x && px <= this.x+this.w && py >= this.y && py <= this.y+this.h; }
    draw(ctx){
      let img = imgs.portal_blue;
      if(this.kind === 'purple') img = imgs.portal_purple;
      if(this.kind === 'gold') img = imgs.portal_gold;
      ctx.save();
      ctx.drawImage(img, this.x*SCALE_X, this.y*SCALE_Y, this.w*SCALE_X, this.h*SCALE_Y);
      ctx.restore();
    }
  }

  class Board {
    constructor(seed){
      this.panels = [];
      this.zones = [];
      this.warps = [];
      this.gates = [];
      this.portals = [];
      this.seed = seed;
      this.rng = rand(seed);
      this.generate();
      // callbacks
      this.onGatePassed = (g)=>{ gameState.onGatePassed(g); };
      this.onPortalEntered = (p)=>{ gameState.onPortal(p); };
      this.onMiss = (orb)=>{ gameState.onMiss(orb); };
    }
    generate(){
      // Create some panels from presets + light randomness
      const presets = CONFIG.board.presets;
      const pidx = Math.floor(this.rng() * presets.length);
      const preset = presets[pidx];
      // panels
      for(const seg of preset.panels){
        const jitter = (v)=> v + (this.rng()-0.5)*60;
        this.panels.push(new Panel(jitter(seg[0]), jitter(seg[1]), jitter(seg[2]), jitter(seg[3])));
      }
      // zones
      for(const z of preset.zones || []){
        this.zones.push(new Zone(z[0], z[1], z[2], z[3], z[4]));
      }
      // warps: pairs
      let wid = 1;
      for(const w of preset.warps || []){
        const wa = new Warp(w[0], w[1], w[2], wid++);
        const wb = new Warp(w[3], w[4], w[2], wid++);
        wa.partner = wb; wb.partner = wa;
        this.warps.push(wa, wb);
      }
      // gates
      let gid = 1;
      for(const g of preset.gates || []){
        this.gates.push(new Gate(g[0], g[1], g[2], g[3], gid++));
      }
      // portals (bottom)
      // choose 3 by default; variants by preset
      const baseY = VIRTUAL_H - 110;
      const kinds = ['blue','purple','gold'];
      const count = preset.portals || 3;
      const w = 160, h = 70;
      const gap = (VIRTUAL_W - count*w) / (count+1);
      for(let i=0;i<count;i++){
        const x = gap + i*(w+gap);
        const kind = kinds[Math.floor(this.rng()*kinds.length)];
        this.portals.push(new Portal(x, baseY, w, h, kind));
      }
    }
    draw(ctx){
      // background extras
      // panels
      for(const p of this.panels) p.draw(ctx);
      // zones
      for(const z of this.zones) z.draw(ctx);
      // warps
      for(const w of this.warps) w.draw(ctx);
      // gates
      for(const g of this.gates) g.draw(ctx);
      // portals
      for(const p of this.portals) p.draw(ctx);
    }
  }

  // Game state + logic
  const gameState = {
    score: 0,
    shotsLeft: CONFIG.shotsPerGame,
    energy: 0,
    combo: 0,
    isFlow: false,
    flowTimeLeft: 0,
    rngSeed: Date.now() & 0xffffffff,
    recentShots: [], // store last N shot results for bonus modifiers
    currentOrb: null,
    orbIndex: 0,
    board: null,
    highScore: parseInt(localStorage.getItem('oc_highscore')||'0'),
    settings: { sound:true, vibration:true }
  };

  function newBoard(){
    gameState.board = new Board(gameState.rngSeed);
  }

  // scoring helpers
  function portalScore(kind){
    const map = CONFIG.scores.portals;
    return map[kind] || map.blue;
  }

  // Bonus/Flow draw
  function calcBonusProb(){
    let p = CONFIG.bonus.baseProb;
    // last 3 shots gold
    const last3 = gameState.recentShots.slice(-3);
    if(last3.some(s=>s.portalKind==='gold')) p += 0.05;
    const zeroCount = last3.filter(s=>s.missed).length;
    if(zeroCount >= 2) p += 0.06;
    if(gameState.combo >= 2) p += 0.03;
    return Math.min(p, CONFIG.bonus.cap);
  }

  function doEnergyCheck(){
    if(gameState.energy >= 100){
      gameState.energy = 0;
      const p = calcBonusProb();
      const r = Math.random();
      playBonusAnimation(r < p);
      if(r < p) enterFlow();
    }
  }

  function playBonusAnimation(success){
    // simple visual flash
    flashTimer = success ? 0.8 : 0.6;
    flashStrong = success;
  }

  function enterFlow(){
    gameState.isFlow = true;
    gameState.flowTimeLeft = CONFIG.flow.baseDuration;
  }

  function doFlowExtendDraw(){
    const r = Math.random();
    if(r < CONFIG.flow.extendProb){
      const add = CONFIG.flow.extendSeconds;
      gameState.flowTimeLeft = Math.min(gameState.flowTimeLeft + add, CONFIG.flow.extendCap);
    }
  }

  // board callbacks
  Board.prototype.onGatePassed = function(g){ /* handled via binding */ };
  Board.prototype.onPortalEntered = function(p){
    // score and energy
    const base = portalScore(p.kind);
    const mult = gameState.isFlow ? CONFIG.flow.scoreMultiplier : 1.0;
    const added = Math.round(base * mult);
    gameState.score += added;
    // gateCount & combo logic
    gameState.combo = (gameState.currentOrb && gameState.currentOrb.gatePassed.size>0) ? gameState.combo+1 : 1;
    // energy
    const energyAdd = (p.kind==='gold'?CONFIG.scores.energy.gold:CONFIG.scores.energy.default);
    gameState.energy = clamp(gameState.energy + energyAdd * (gameState.isFlow ? CONFIG.flow.energyMultiplier : 1.0), 0, 100);
    // record shot
    gameState.recentShots.push({ portalKind: p.kind, missed:false });
    if(gameState.recentShots.length > 10) gameState.recentShots.shift();
    // shot ended
    gameState.currentOrb = null;
    gameState.shotsLeft -= 1;
    // persist if highscore
    if(gameState.score > gameState.highScore){
      gameState.highScore = gameState.score;
      localStorage.setItem('oc_highscore', gameState.highScore);
    }
    doEnergyCheck();
  };
  Board.prototype.onMiss = function(orb){
    // small energy reward optional
    gameState.energy = clamp(gameState.energy + CONFIG.scores.energy.onMiss, 0, 100);
    gameState.recentShots.push({ portalKind:null, missed:true });
    if(gameState.recentShots.length > 10) gameState.recentShots.shift();
    gameState.currentOrb = null;
    gameState.combo = 0;
    gameState.shotsLeft -= 1;
    doEnergyCheck();
  };
  Board.prototype.onGatePassed = function(g){
    gameState.score += CONFIG.scores.gate;
    gameState.energy = clamp(gameState.energy + CONFIG.scores.energy.gate, 0, 100);
  };

  // input handling: drag to aim
  let isDragging = false;
  let dragStart = null;
  let dragPos = null;
  let lastTouch = null;
  const launchBase = { x: VIRTUAL_W/2, y: 1220 };

  function screenToVirtual(sx, sy){
    const rect = canvas.getBoundingClientRect();
    const cx = (sx - rect.left) / rect.width * CANVAS_W;
    const cy = (sy - rect.top) / rect.height * CANVAS_H;
    return { x: cx / SCALE_X, y: cy / SCALE_Y };
  }

  canvas.addEventListener('pointerdown', (e)=>{
    isDragging = true;
    const p = screenToVirtual(e.clientX, e.clientY);
    dragStart = p; dragPos = p;
    lastTouch = e;
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e)=>{
    if(!isDragging) return;
    const p = screenToVirtual(e.clientX, e.clientY);
    dragPos = p;
  });
  window.addEventListener('pointerup', (e)=>{
    if(!isDragging) return;
    isDragging = false;
    // compute angle & power
    const dx = dragStart.x - dragPos.x;
    const dy = dragStart.y - dragPos.y;
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    // map to -80 ~ -20 degrees upward
    // compute vector from vertical aiming
    const vecx = dragStart.x - dragPos.x;
    const vecy = dragStart.y - dragPos.y;
    const dist = Math.hypot(vecx, vecy);
    if(dist < 10) return;
    doFireFromInput(vecx, vecy);
  });

  // keyboard: space to fire with default angle
  window.addEventListener('keydown', (e)=>{
    if(e.code === 'Space'){ e.preventDefault(); if(!isDragging) doFireAuto(); }
  });

  fireBtn.addEventListener('click', (e)=>{ doFireAuto(); });

  function doFireAuto(){
    // small auto-aim: straight up with medium power
    if(gameState.currentOrb || gameState.shotsLeft <= 0) return;
    const power = (CONFIG.fire.max + CONFIG.fire.min) / 2;
    const angleDeg = -50 * Math.PI/180;
    spawnOrb(angleDeg, power);
  }

  function doFireFromInput(dx, dy){
    if(gameState.currentOrb || gameState.shotsLeft <= 0) return;
    // map swipe length to power
    const length = Math.hypot(dx,dy);
    const t = clamp((length - 10) / 200, 0, 1);
    const power = CONFIG.fire.min + t * (CONFIG.fire.max - CONFIG.fire.min);
    // angle in radians: restrict to -80 ~ -20 degrees (up-left/up-right)
    let angle = Math.atan2(dy, dx); // direction from dragStart -> dragPos
    // we want angle pointing from launch to upwards: invert
    angle += Math.PI; // direction of launch
    const deg = angle * 180/Math.PI;
    const clampedDeg = clamp(deg, -80, -20);
    const rad = clampedDeg * Math.PI/180;
    spawnOrb(rad, power);
  }

  function spawnOrb(angleRad, power){
    const vx = Math.cos(angleRad) * power;
    const vy = Math.sin(angleRad) * power;
    gameState.currentOrb = new Orb(launchBase.x, launchBase.y, vx, vy, ++gameState.orbIndex);
  }

  // Rendering helpers
  function drawGuide(ctx){
    if(!isDragging) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6,6]);
    ctx.beginPath();
    const sx = dragStart.x * SCALE_X, sy = dragStart.y * SCALE_Y;
    const tx = dragPos.x * SCALE_X, ty = dragPos.y * SCALE_Y;
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.restore();
  }

  // flash effect for bonus animation
  let flashTimer = 0;
  let flashStrong = false;

  // main loop
  let lastTs = performance.now();
  function tick(ts){
    const dtRaw = (ts - lastTs) / 1000;
    lastTs = ts;
    const dt = clamp(dtRaw, 0, 0.05); // avoid large steps

    // update
    if(gameState.isFlow){
      gameState.flowTimeLeft -= dt;
      if(gameState.flowTimeLeft <= 0){
        gameState.isFlow = false;
        doFlowExtendDraw();
      }
    }

    if(gameState.currentOrb){
      gameState.currentOrb.update(dt, gameState.board);
    } else {
      // idle
    }

    // update UI
    scoreBox.textContent = `Score: ${gameState.score}`;
    shotsBox.textContent = `Shots: ${gameState.shotsLeft}`;
    flowBox.textContent = gameState.isFlow ? `Flow: ${Math.ceil(gameState.flowTimeLeft)}s` : `Flow: -`;

    // background clear
    ctx.fillStyle = '#061426';
    ctx.fillRect(0,0,CANVAS_W,CANVAS_H);

    // draw board
    if(gameState.board) gameState.board.draw(ctx);

    // draw orb
    if(gameState.currentOrb) gameState.currentOrb.draw(ctx);

    // draw aim guide
    if(isDragging) drawGuide(ctx);

    // HUD overlays
    // energy bar
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(14, 48, 120, 8);
    ctx.fillStyle = '#7fe0a4';
    ctx.fillRect(14, 48, 120 * (gameState.energy/100), 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(14, 48, 120, 8);
    ctx.restore();

    // flow flash
    if(flashTimer > 0){
      flashTimer -= dt;
      ctx.save();
      ctx.globalAlpha = Math.min(1, flashTimer / 0.8);
      ctx.fillStyle = flashStrong ? 'rgba(255,220,120,0.38)' : 'rgba(180,200,240,0.28)';
      ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
      ctx.restore();
    }

    // end of game
    if(gameState.shotsLeft <= 0 && !gameState.currentOrb){
      // show result overlay briefly (simple)
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
      ctx.fillStyle = '#fff'; ctx.font = '18px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Result', CANVAS_W/2, CANVAS_H/2 - 40);
      ctx.fillText(`Score: ${gameState.score}`, CANVAS_W/2, CANVAS_H/2 - 10);
      ctx.fillText(`High: ${gameState.highScore}`, CANVAS_W/2, CANVAS_H/2 + 20);
      ctx.restore();
    } else {
      requestAnimationFrame(tick);
    }
  }

  // start new game
  function startNewGame(seedOverride){
    gameState.score = 0;
    gameState.shotsLeft = CONFIG.shotsPerGame;
    gameState.energy = 0;
    gameState.combo = 0;
    gameState.isFlow = false;
    gameState.flowTimeLeft = 0;
    gameState.currentOrb = null;
    gameState.orbIndex = 0;
    gameState.recentShots = [];
    gameState.rngSeed = (seedOverride !== undefined) ? seedOverride : (Date.now() & 0xffffffff);
    newBoard();
    lastTs = performance.now();
    requestAnimationFrame(tick);
  }

  // initial
  startNewGame();

  // Expose small controls to console for testing
  window.OC = {
    cfg: CONFIG,
    gs: gameState,
    restart: (s)=>startNewGame(s),
    spawn: (angleDeg,power)=>spawnOrb(angleDeg*Math.PI/180, power)
  };
}
