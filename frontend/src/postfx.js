import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Barrel Distortion Shader for Crucible Mode
const LensDistortionShader = {
    uniforms: {
        tDiffuse: { value: null },
        uDistortion: { value: 0.0 }, // 0 = no distortion, max ~0.5
        uTime: { value: 0 }
    },
    vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
    fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uDistortion;
    uniform float uTime;
    varying vec2 vUv;
    
    void main() {
      vec2 uv = vUv;
      
      if (uDistortion > 0.0) {
        vec2 ctr = vec2(0.5);
        vec2 dir = uv - ctr;
        float d = length(dir);
        
        // Barrel distortion: pixels further from center are squeezed
        float rr = d * d;
        float f = 1.0 + rr * uDistortion;
        
        vec2 mappedUv = ctr + dir * f;
        
        // Chromatic aberration at the fringes
        float ca = uDistortion * d * 0.04;
        float r = texture2D(tDiffuse, mappedUv - dir * ca).r;
        float g = texture2D(tDiffuse, mappedUv).g;
        float b = texture2D(tDiffuse, mappedUv + dir * ca).b;
        
        gl_FragColor = vec4(r, g, b, 1.0);
        
        // Darken edges slightly for the lens feeling (vignette)
        gl_FragColor.rgb *= smoothstep(0.85, 0.4, d);
      } else {
        gl_FragColor = texture2D(tDiffuse, uv);
      }
    }
  `
};

let composer;
let lensPass;
let active = false;

export function initPostProcessing(renderer, scene, camera) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    lensPass = new ShaderPass(LensDistortionShader);
    composer.addPass(lensPass);
}

export function resizePostProcessing(width, height) {
    if (composer) composer.setSize(width, height);
}

export function setCrucibleLens(enabled) {
    active = enabled;
}

export function updateAndRender(dt, renderer, scene, camera) {
    if (!composer) {
        renderer.render(scene, camera);
        return;
    }

    // Smoothly blend distortion in and out
    const targetDistortion = active ? 0.45 : 0.0;
    lensPass.uniforms.uDistortion.value += (targetDistortion - lensPass.uniforms.uDistortion.value) * 0.06;
    lensPass.uniforms.uTime.value += dt;

    // Optimisation: if effect is fully off, just render normally
    if (!active && lensPass.uniforms.uDistortion.value < 0.001) {
        renderer.render(scene, camera);
    } else {
        composer.render();
    }
}
