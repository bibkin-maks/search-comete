"""
search-comete - pipeline/run.py

Usage:
  # Quick test - 10 papers per topic (~3,000 total, ~5 min)
  python -m pipeline.run --limit 10 --skip-index

  # Good run - 50 papers per topic (~15,000 total, ~45 min)
  python -m pipeline.run --limit 50 --skip-index

  # Maximum - 200 papers per topic (~60,000 total, several hours)
  python -m pipeline.run --limit 200 --skip-index

  # Resume after a crash
  python -m pipeline.run --limit 50 --skip-index --resume

  # Only fetch specific clusters
  python -m pipeline.run --limit 50 --skip-index --clusters ml,bio,phys

  # Re-embed + re-UMAP without re-fetching
  python -m pipeline.run --skip-fetch --skip-index
"""

import argparse, json, os
import numpy as np
from collections import Counter
from elasticsearch import Elasticsearch

from .fetch       import fetch_openalex, fetch_semantic_scholar, fetch_arxiv, deduplicate
from .embed       import load_model, embed_papers
from .umap_reduce import run_umap
from .index       import setup_index, build_docs, bulk_index

TOPICS = [
    # ── Machine Learning (50 topics) ─────────────────────────────────────────
    ("transformer attention mechanism self-attention",            "ml",    "Machine Learning",   "#7c6dfa"),
    ("vision transformer ViT image patch embedding",             "ml",    "Machine Learning",   "#7c6dfa"),
    ("cross-attention multi-head attention positional encoding", "ml",    "Machine Learning",   "#7c6dfa"),
    ("large language model GPT instruction tuning RLHF",         "ml",    "Machine Learning",   "#7c6dfa"),
    ("BERT pre-training masked language model NLP",              "ml",    "Machine Learning",   "#7c6dfa"),
    ("LLM reasoning chain-of-thought prompting",                 "ml",    "Machine Learning",   "#7c6dfa"),
    ("parameter efficient fine-tuning LoRA adapter",             "ml",    "Machine Learning",   "#7c6dfa"),
    ("scaling laws language model compute",                      "ml",    "Machine Learning",   "#7c6dfa"),
    ("retrieval augmented generation RAG knowledge",             "ml",    "Machine Learning",   "#7c6dfa"),
    ("hallucination factuality language model alignment",        "ml",    "Machine Learning",   "#7c6dfa"),
    ("diffusion model score matching denoising synthesis",       "ml",    "Machine Learning",   "#7c6dfa"),
    ("generative adversarial network GAN image generation",      "ml",    "Machine Learning",   "#7c6dfa"),
    ("variational autoencoder latent space generation",          "ml",    "Machine Learning",   "#7c6dfa"),
    ("text-to-image generation stable diffusion DALL-E",         "ml",    "Machine Learning",   "#7c6dfa"),
    ("reinforcement learning policy gradient actor critic",      "ml",    "Machine Learning",   "#7c6dfa"),
    ("deep Q-network Atari reward exploration",                  "ml",    "Machine Learning",   "#7c6dfa"),
    ("model-based reinforcement learning world model",           "ml",    "Machine Learning",   "#7c6dfa"),
    ("multi-agent reinforcement learning cooperative game",      "ml",    "Machine Learning",   "#7c6dfa"),
    ("graph neural network node classification message passing", "ml",    "Machine Learning",   "#7c6dfa"),
    ("knowledge graph embedding link prediction",                "ml",    "Machine Learning",   "#7c6dfa"),
    ("convolutional neural network ResNet image recognition",    "ml",    "Machine Learning",   "#7c6dfa"),
    ("object detection YOLO anchor-free head",                   "ml",    "Machine Learning",   "#7c6dfa"),
    ("semantic segmentation instance panoptic pixel",            "ml",    "Machine Learning",   "#7c6dfa"),
    ("3D point cloud LiDAR depth estimation",                    "ml",    "Machine Learning",   "#7c6dfa"),
    ("batch normalization dropout regularization training",      "ml",    "Machine Learning",   "#7c6dfa"),
    ("Adam optimizer learning rate schedule warmup",             "ml",    "Machine Learning",   "#7c6dfa"),
    ("knowledge distillation model compression quantization",    "ml",    "Machine Learning",   "#7c6dfa"),
    ("neural architecture search AutoML hyperparameter",         "ml",    "Machine Learning",   "#7c6dfa"),
    ("self-supervised contrastive learning SimCLR BYOL",         "ml",    "Machine Learning",   "#7c6dfa"),
    ("transfer learning domain adaptation fine-tune",            "ml",    "Machine Learning",   "#7c6dfa"),
    ("meta-learning few-shot MAML prototypical network",         "ml",    "Machine Learning",   "#7c6dfa"),
    ("continual learning catastrophic forgetting lifelong",      "ml",    "Machine Learning",   "#7c6dfa"),
    ("multimodal vision language CLIP contrastive",              "ml",    "Machine Learning",   "#7c6dfa"),
    ("video understanding temporal action recognition",          "ml",    "Machine Learning",   "#7c6dfa"),
    ("speech recognition whisper audio transformer wav2vec",     "ml",    "Machine Learning",   "#7c6dfa"),
    ("federated learning privacy gradient aggregation",          "ml",    "Machine Learning",   "#7c6dfa"),
    ("recommender system collaborative filtering matrix",        "ml",    "Machine Learning",   "#7c6dfa"),
    ("anomaly detection out-of-distribution uncertainty",        "ml",    "Machine Learning",   "#7c6dfa"),
    ("time series forecasting temporal prediction",              "ml",    "Machine Learning",   "#7c6dfa"),
    ("machine translation sequence-to-sequence BLEU",           "ml",    "Machine Learning",   "#7c6dfa"),
    ("information extraction named entity relation",             "ml",    "Machine Learning",   "#7c6dfa"),
    ("interpretability explainability SHAP attention",           "ml",    "Machine Learning",   "#7c6dfa"),
    ("fairness bias machine learning algorithmic",               "ml",    "Machine Learning",   "#7c6dfa"),
    ("adversarial robustness attack defense perturbation",       "ml",    "Machine Learning",   "#7c6dfa"),
    ("Mamba state space model linear attention",                 "ml",    "Machine Learning",   "#7c6dfa"),
    ("mixture of experts sparse MoE routing",                    "ml",    "Machine Learning",   "#7c6dfa"),
    ("neural network pruning sparsity lottery ticket",           "ml",    "Machine Learning",   "#7c6dfa"),
    ("in-context learning few-shot prompting emergence",         "ml",    "Machine Learning",   "#7c6dfa"),
    ("code generation LLM programming debugging",                "ml",    "Machine Learning",   "#7c6dfa"),
    ("medical AI clinical NLP healthcare prediction",            "ml",    "Machine Learning",   "#7c6dfa"),

    # ── Biology (30 topics) ───────────────────────────────────────────────────
    ("CRISPR Cas9 base editing prime editing genome",            "bio",   "Biology",            "#3dd9a4"),
    ("protein structure prediction AlphaFold ESMFold",          "bio",   "Biology",            "#3dd9a4"),
    ("single cell RNA sequencing scRNA-seq cell type",           "bio",   "Biology",            "#3dd9a4"),
    ("spatial transcriptomics tissue gene expression",           "bio",   "Biology",            "#3dd9a4"),
    ("cancer immunotherapy checkpoint inhibitor T-cell",         "bio",   "Biology",            "#3dd9a4"),
    ("tumor microenvironment immunosuppression therapy",         "bio",   "Biology",            "#3dd9a4"),
    ("gut microbiome microbiota dysbiosis host",                 "bio",   "Biology",            "#3dd9a4"),
    ("neuroscience synapse plasticity memory learning",          "bio",   "Biology",            "#3dd9a4"),
    ("drug discovery virtual screening docking target",         "bio",   "Biology",            "#3dd9a4"),
    ("epigenetics histone methylation chromatin accessibility",  "bio",   "Biology",            "#3dd9a4"),
    ("evolution natural selection phylogeny speciation",         "bio",   "Biology",            "#3dd9a4"),
    ("stem cell iPSC organoid differentiation",                  "bio",   "Biology",            "#3dd9a4"),
    ("SARS-CoV-2 COVID-19 spike immune response",                "bio",   "Biology",            "#3dd9a4"),
    ("antibiotic resistance AMR bacteria mechanism",             "bio",   "Biology",            "#3dd9a4"),
    ("cell signaling mTOR PI3K kinase pathway",                  "bio",   "Biology",            "#3dd9a4"),
    ("protein-protein interaction binding affinity",             "bio",   "Biology",            "#3dd9a4"),
    ("metabolomics metabolite metabolic pathway flux",           "bio",   "Biology",            "#3dd9a4"),
    ("proteomics mass spectrometry post-translational",          "bio",   "Biology",            "#3dd9a4"),
    ("RNA splicing non-coding long ncRNA miRNA",                 "bio",   "Biology",            "#3dd9a4"),
    ("synthetic biology genetic circuit biosensor",              "bio",   "Biology",            "#3dd9a4"),
    ("aging senescence telomere longevity lifespan",             "bio",   "Biology",            "#3dd9a4"),
    ("structural biology cryo-EM X-ray crystallography",         "bio",   "Biology",            "#3dd9a4"),
    ("GWAS genome-wide association polymorphism trait",          "bio",   "Biology",            "#3dd9a4"),
    ("immunology B cell antibody innate adaptive immune",        "bio",   "Biology",            "#3dd9a4"),
    ("virology virus replication tropism pathogenesis",          "bio",   "Biology",            "#3dd9a4"),
    ("population genetics selection drift admixture",            "bio",   "Biology",            "#3dd9a4"),
    ("cell cycle mitosis apoptosis proliferation",               "bio",   "Biology",            "#3dd9a4"),
    ("plant biology photosynthesis stress drought",              "bio",   "Biology",            "#3dd9a4"),
    ("bioinformatics sequence alignment genome assembly",        "bio",   "Biology",            "#3dd9a4"),
    ("neural circuit connectome brain mapping wiring",           "bio",   "Biology",            "#3dd9a4"),

    # ── Physics (25 topics) ───────────────────────────────────────────────────
    ("gravitational waves LIGO black hole neutron star merger",  "phys",  "Physics",            "#fa8c4f"),
    ("quantum computing qubit gate circuit error correction",    "phys",  "Physics",            "#fa8c4f"),
    ("dark energy cosmological constant expansion acceleration", "phys",  "Physics",            "#fa8c4f"),
    ("superconductor BCS Cooper pair gap transition",            "phys",  "Physics",            "#fa8c4f"),
    ("Higgs boson standard model electroweak LHC",               "phys",  "Physics",            "#fa8c4f"),
    ("quantum entanglement Bell inequality nonlocality",         "phys",  "Physics",            "#fa8c4f"),
    ("plasma fusion tokamak magnetic confinement energy",        "phys",  "Physics",            "#fa8c4f"),
    ("topological insulator quantum Hall edge state surface",    "phys",  "Physics",            "#fa8c4f"),
    ("exoplanet transit spectroscopy atmosphere habitable",      "phys",  "Physics",            "#fa8c4f"),
    ("quantum field theory gauge symmetry renormalization",      "phys",  "Physics",            "#fa8c4f"),
    ("graphene 2D material van der Waals heterostructure",       "phys",  "Physics",            "#fa8c4f"),
    ("photonics nanophotonics waveguide resonator nonlinear",    "phys",  "Physics",            "#fa8c4f"),
    ("cosmic microwave background inflation CMB tensor",         "phys",  "Physics",            "#fa8c4f"),
    ("black hole entropy Hawking radiation AdS/CFT",             "phys",  "Physics",            "#fa8c4f"),
    ("condensed matter strongly correlated Mott insulator",      "phys",  "Physics",            "#fa8c4f"),
    ("spin qubit semiconductor quantum dot coherence",           "phys",  "Physics",            "#fa8c4f"),
    ("dark matter axion WIMP detection signal",                  "phys",  "Physics",            "#fa8c4f"),
    ("nuclear physics fission fusion cross section",             "phys",  "Physics",            "#fa8c4f"),
    ("magnetism spintronics ferromagnet skyrmion Hall",          "phys",  "Physics",            "#fa8c4f"),
    ("laser ultrafast femtosecond pulse spectroscopy",           "phys",  "Physics",            "#fa8c4f"),
    ("neutron star equation of state dense matter",              "phys",  "Physics",            "#fa8c4f"),
    ("quantum optics photon entanglement cavity QED",            "phys",  "Physics",            "#fa8c4f"),
    ("solar physics corona flare magnetohydrodynamics",          "phys",  "Physics",            "#fa8c4f"),
    ("string theory supersymmetry extra dimensions duality",     "phys",  "Physics",            "#fa8c4f"),
    ("high energy cosmic ray gamma ray detector",                "phys",  "Physics",            "#fa8c4f"),

    # ── Computer Science (25 topics) ──────────────────────────────────────────
    ("distributed systems consensus Raft Paxos fault",           "cs",    "Computer Science",   "#5ab4f5"),
    ("database query optimization index B-tree",                 "cs",    "Computer Science",   "#5ab4f5"),
    ("cryptography zero-knowledge proof homomorphic",            "cs",    "Computer Science",   "#5ab4f5"),
    ("blockchain smart contract decentralized consensus",        "cs",    "Computer Science",   "#5ab4f5"),
    ("network security intrusion detection malware",             "cs",    "Computer Science",   "#5ab4f5"),
    ("compiler optimization LLVM IR code generation",            "cs",    "Computer Science",   "#5ab4f5"),
    ("operating system kernel scheduler memory management",      "cs",    "Computer Science",   "#5ab4f5"),
    ("parallel computing GPU CUDA accelerator HPC",              "cs",    "Computer Science",   "#5ab4f5"),
    ("cloud computing serverless container orchestration k8s",   "cs",    "Computer Science",   "#5ab4f5"),
    ("algorithm graph traversal complexity NP-hard",             "cs",    "Computer Science",   "#5ab4f5"),
    ("formal verification model checking theorem proving",       "cs",    "Computer Science",   "#5ab4f5"),
    ("computer graphics ray tracing rendering pipeline",         "cs",    "Computer Science",   "#5ab4f5"),
    ("robotics SLAM path planning manipulation grasping",        "cs",    "Computer Science",   "#5ab4f5"),
    ("programming language type system functional logic",        "cs",    "Computer Science",   "#5ab4f5"),
    ("human computer interaction UX accessibility",              "cs",    "Computer Science",   "#5ab4f5"),
    ("information retrieval search engine ranking",              "cs",    "Computer Science",   "#5ab4f5"),
    ("network protocol TCP congestion routing BGP",              "cs",    "Computer Science",   "#5ab4f5"),
    ("quantum algorithm Shor Grover amplitude",                  "cs",    "Computer Science",   "#5ab4f5"),
    ("edge computing IoT embedded real-time",                    "cs",    "Computer Science",   "#5ab4f5"),
    ("differential privacy noise mechanism release",             "cs",    "Computer Science",   "#5ab4f5"),
    ("autonomous driving perception planning control",           "cs",    "Computer Science",   "#5ab4f5"),
    ("augmented reality virtual reality XR mixed",               "cs",    "Computer Science",   "#5ab4f5"),
    ("computer vision stereo depth optical flow tracking",       "cs",    "Computer Science",   "#5ab4f5"),
    ("software engineering testing debugging refactoring",       "cs",    "Computer Science",   "#5ab4f5"),
    ("data stream processing approximate query sketching",       "cs",    "Computer Science",   "#5ab4f5"),

    # ── Mathematics (20 topics) ───────────────────────────────────────────────
    ("topology manifold homology homotopy invariant",            "math",  "Mathematics",        "#f06ba8"),
    ("convex optimization gradient descent convergence",         "math",  "Mathematics",        "#f06ba8"),
    ("stochastic differential equation Brownian Ito",            "math",  "Mathematics",        "#f06ba8"),
    ("number theory prime Riemann hypothesis zeta",              "math",  "Mathematics",        "#f06ba8"),
    ("partial differential equation elliptic parabolic",        "math",  "Mathematics",        "#f06ba8"),
    ("combinatorics extremal graph Ramsey coloring",             "math",  "Mathematics",        "#f06ba8"),
    ("algebraic geometry variety scheme cohomology",             "math",  "Mathematics",        "#f06ba8"),
    ("probability martingale concentration inequality",          "math",  "Mathematics",        "#f06ba8"),
    ("functional analysis Banach Hilbert operator spectral",     "math",  "Mathematics",        "#f06ba8"),
    ("numerical analysis finite element method error",           "math",  "Mathematics",        "#f06ba8"),
    ("game theory Nash equilibrium mechanism design",            "math",  "Mathematics",        "#f06ba8"),
    ("Riemannian geometry curvature geodesic metric",            "math",  "Mathematics",        "#f06ba8"),
    ("optimal transport Wasserstein distance coupling",          "math",  "Mathematics",        "#f06ba8"),
    ("random matrix spectral distribution Wigner",               "math",  "Mathematics",        "#f06ba8"),
    ("group theory representation character symmetry",           "math",  "Mathematics",        "#f06ba8"),
    ("dynamical system chaos bifurcation attractor",             "math",  "Mathematics",        "#f06ba8"),
    ("Bayesian inference prior posterior sampling MCMC",         "math",  "Mathematics",        "#f06ba8"),
    ("information theory entropy channel capacity coding",       "math",  "Mathematics",        "#f06ba8"),
    ("knot theory braid link invariant polynomial",              "math",  "Mathematics",        "#f06ba8"),
    ("compressed sensing sparse recovery random projection",     "math",  "Mathematics",        "#f06ba8"),

    # ── Chemistry (15 topics) ─────────────────────────────────────────────────
    ("catalysis heterogeneous transition metal surface",         "chem",  "Chemistry",          "#f9c74f"),
    ("organic synthesis reaction mechanism selectivity",         "chem",  "Chemistry",          "#f9c74f"),
    ("polymer nanocomposite mechanical thermal property",        "chem",  "Chemistry",          "#f9c74f"),
    ("lithium ion battery electrolyte anode cathode",            "chem",  "Chemistry",          "#f9c74f"),
    ("density functional theory DFT molecular dynamics",         "chem",  "Chemistry",          "#f9c74f"),
    ("NMR spectroscopy chemical shift structure",                "chem",  "Chemistry",          "#f9c74f"),
    ("photocatalysis solar energy water splitting hydrogen",      "chem",  "Chemistry",          "#f9c74f"),
    ("supramolecular chemistry host guest self-assembly",        "chem",  "Chemistry",          "#f9c74f"),
    ("enzyme kinetics inhibition active site mechanism",         "chem",  "Chemistry",          "#f9c74f"),
    ("metal-organic framework porous material adsorption",       "chem",  "Chemistry",          "#f9c74f"),
    ("electrochemistry redox electrode cyclic voltammetry",      "chem",  "Chemistry",          "#f9c74f"),
    ("nanoparticle synthesis functionalization surface",         "chem",  "Chemistry",          "#f9c74f"),
    ("perovskite solar cell efficiency stability",                "chem",  "Chemistry",          "#f9c74f"),
    ("green chemistry sustainable solvent process",              "chem",  "Chemistry",          "#f9c74f"),
    ("drug delivery nanocarrier liposome release",               "chem",  "Chemistry",          "#f9c74f"),

    # ── Economics (15 topics) ─────────────────────────────────────────────────
    ("causal inference difference-in-differences instrumental",  "econ",  "Economics",          "#90e0ef"),
    ("financial market asset pricing volatility return",         "econ",  "Economics",          "#90e0ef"),
    ("auction mechanism design Bayesian equilibrium",            "econ",  "Economics",          "#90e0ef"),
    ("labour economics wage inequality unemployment",            "econ",  "Economics",          "#90e0ef"),
    ("monetary policy inflation central bank interest rate",     "econ",  "Economics",          "#90e0ef"),
    ("social network diffusion influence viral spread",          "econ",  "Economics",          "#90e0ef"),
    ("development economics poverty growth institution",         "econ",  "Economics",          "#90e0ef"),
    ("behavioural economics nudge bounded rationality",          "econ",  "Economics",          "#90e0ef"),
    ("political economy voting institution democracy",           "econ",  "Economics",          "#90e0ef"),
    ("machine learning prediction policy treatment effect",      "econ",  "Economics",          "#90e0ef"),
    ("health economics insurance hospital cost",                 "econ",  "Economics",          "#90e0ef"),
    ("urban economics city agglomeration housing rent",          "econ",  "Economics",          "#90e0ef"),
    ("trade comparative advantage tariff global",                "econ",  "Economics",          "#90e0ef"),
    ("firm productivity innovation R&D patent",                  "econ",  "Economics",          "#90e0ef"),
    ("natural language processing text economics measurement",   "econ",  "Economics",          "#90e0ef"),

    # ── Environment (15 topics) ───────────────────────────────────────────────
    ("climate change global warming temperature projection",     "env",   "Environment",        "#52b788"),
    ("renewable energy solar wind photovoltaic grid",            "env",   "Environment",        "#52b788"),
    ("ocean acidification sea level rise coral reef",            "env",   "Environment",        "#52b788"),
    ("biodiversity species extinction habitat loss",             "env",   "Environment",        "#52b788"),
    ("carbon capture storage sequestration direct air",          "env",   "Environment",        "#52b788"),
    ("air quality PM2.5 ozone pollution health effect",          "env",   "Environment",        "#52b788"),
    ("wildfire deforestation land use change emissions",         "env",   "Environment",        "#52b788"),
    ("Arctic permafrost methane tipping point feedback",         "env",   "Environment",        "#52b788"),
    ("water scarcity drought irrigation agriculture",            "env",   "Environment",        "#52b788"),
    ("energy transition decarbonisation net zero policy",        "env",   "Environment",        "#52b788"),
    ("climate model precipitation extreme event flood",         "env",   "Environment",        "#52b788"),
    ("plastic pollution microplastic ocean marine",              "env",   "Environment",        "#52b788"),
    ("nitrogen cycle eutrophication fertilizer runoff",          "env",   "Environment",        "#52b788"),
    ("remote sensing satellite land cover forest",               "env",   "Environment",        "#52b788"),
    ("ecosystem services valuation nature biodiversity",         "env",   "Environment",        "#52b788"),

    # ── Medicine (20 topics) ──────────────────────────────────────────────────
    ("clinical trial randomized controlled placebo endpoint",    "med",   "Medicine",           "#e63946"),
    ("medical imaging deep learning radiology diagnosis",        "med",   "Medicine",           "#e63946"),
    ("electronic health record EHR prediction mortality",        "med",   "Medicine",           "#e63946"),
    ("mental health depression anxiety CBT therapy",             "med",   "Medicine",           "#e63946"),
    ("surgical outcome complication minimally invasive robot",   "med",   "Medicine",           "#e63946"),
    ("epidemiology incidence prevalence risk cohort",            "med",   "Medicine",           "#e63946"),
    ("precision medicine genomic biomarker targeted",            "med",   "Medicine",           "#e63946"),
    ("vaccine mRNA immunogenicity efficacy safety",              "med",   "Medicine",           "#e63946"),
    ("Alzheimer dementia neurodegeneration amyloid tau",         "med",   "Medicine",           "#e63946"),
    ("cardiovascular heart failure myocardial infarction",       "med",   "Medicine",           "#e63946"),
    ("diabetes insulin metabolic syndrome obesity",              "med",   "Medicine",           "#e63946"),
    ("oncology chemotherapy immunotherapy survival",             "med",   "Medicine",           "#e63946"),
    ("sepsis ICU critical care organ failure",                   "med",   "Medicine",           "#e63946"),
    ("stroke thrombolysis thrombectomy neurological",            "med",   "Medicine",           "#e63946"),
    ("pain management opioid analgesic chronic",                 "med",   "Medicine",           "#e63946"),
    ("rare disease orphan drug genetic disorder",                "med",   "Medicine",           "#e63946"),
    ("nutrition diet micronutrient gut metabolism",              "med",   "Medicine",           "#e63946"),
    ("health equity disparity access social determinant",        "med",   "Medicine",           "#e63946"),
    ("pathogen virulence resistance host infection",             "med",   "Medicine",           "#e63946"),
    ("radiology CT MRI scan detection classification",           "med",   "Medicine",           "#e63946"),

    # ── Materials Science (15 topics) ─────────────────────────────────────────
    ("semiconductor transistor MOSFET silicon fabrication",      "mat",   "Materials Science",  "#c084fc"),
    ("battery solid state electrolyte anode lithium",            "mat",   "Materials Science",  "#c084fc"),
    ("biomaterial scaffold tissue engineering implant",          "mat",   "Materials Science",  "#c084fc"),
    ("high entropy alloy microstructure mechanical",             "mat",   "Materials Science",  "#c084fc"),
    ("thin film deposition sputtering CVD ALD",                  "mat",   "Materials Science",  "#c084fc"),
    ("composite material carbon fibre matrix strength",          "mat",   "Materials Science",  "#c084fc"),
    ("ceramic oxide sintering grain boundary",                   "mat",   "Materials Science",  "#c084fc"),
    ("polymer crystallization glass transition rheology",        "mat",   "Materials Science",  "#c084fc"),
    ("quantum material topological semimetal band",              "mat",   "Materials Science",  "#c084fc"),
    ("additive manufacturing 3D printing laser powder",          "mat",   "Materials Science",  "#c084fc"),
    ("hydrogel soft matter swelling drug release",               "mat",   "Materials Science",  "#c084fc"),
    ("piezoelectric ferroelectric energy harvesting",            "mat",   "Materials Science",  "#c084fc"),
    ("nanomaterial carbon nanotube graphene quantum dot",        "mat",   "Materials Science",  "#c084fc"),
    ("corrosion protective coating oxidation surface",           "mat",   "Materials Science",  "#c084fc"),
    ("shape memory alloy smart material actuation",              "mat",   "Materials Science",  "#c084fc"),

    # ── Neuroscience (15 topics) ──────────────────────────────────────────────
    ("fMRI brain activation BOLD signal task",                   "neuro", "Neuroscience",       "#34d399"),
    ("EEG neural oscillation alpha theta gamma",                 "neuro", "Neuroscience",       "#34d399"),
    ("synaptic plasticity LTP LTD Hebbian learning",             "neuro", "Neuroscience",       "#34d399"),
    ("dopamine reward prediction error basal ganglia",           "neuro", "Neuroscience",       "#34d399"),
    ("prefrontal cortex working memory executive control",       "neuro", "Neuroscience",       "#34d399"),
    ("hippocampus memory consolidation place cell grid",         "neuro", "Neuroscience",       "#34d399"),
    ("neural coding population decoding manifold",               "neuro", "Neuroscience",       "#34d399"),
    ("brain-computer interface neuroprosthetics decode",         "neuro", "Neuroscience",       "#34d399"),
    ("Parkinson disease motor basal ganglia dopamine",           "neuro", "Neuroscience",       "#34d399"),
    ("language brain Broca syntax semantic fMRI",                "neuro", "Neuroscience",       "#34d399"),
    ("consciousness perception awareness binding problem",       "neuro", "Neuroscience",       "#34d399"),
    ("computational neuroscience spiking Hodgkin Huxley",        "neuro", "Neuroscience",       "#34d399"),
    ("sleep slow wave REM memory consolidation",                 "neuro", "Neuroscience",       "#34d399"),
    ("fear amygdala conditioning extinction anxiety",            "neuro", "Neuroscience",       "#34d399"),
    ("autism schizophrenia disorder circuit connectivity",       "neuro", "Neuroscience",       "#34d399"),

    # ── Engineering (15 topics) ───────────────────────────────────────────────
    ("fluid dynamics turbulence Navier-Stokes CFD simulation",   "eng",   "Engineering",        "#fb923c"),
    ("control system PID feedback stability Lyapunov",          "eng",   "Engineering",        "#fb923c"),
    ("signal processing Fourier wavelet filter noise",           "eng",   "Engineering",        "#fb923c"),
    ("power system grid stability renewable integration",        "eng",   "Engineering",        "#fb923c"),
    ("heat transfer thermal conduction convection",              "eng",   "Engineering",        "#fb923c"),
    ("autonomous vehicle lidar camera sensor fusion",            "eng",   "Engineering",        "#fb923c"),
    ("MEMS microelectromechanical sensor actuator",              "eng",   "Engineering",        "#fb923c"),
    ("aerospace aerodynamics wing drag optimization",            "eng",   "Engineering",        "#fb923c"),
    ("structural engineering finite element fatigue",            "eng",   "Engineering",        "#fb923c"),
    ("antenna RF microwave wireless communication",              "eng",   "Engineering",        "#fb923c"),
    ("manufacturing machining surface quality precision",        "eng",   "Engineering",        "#fb923c"),
    ("supply chain logistics optimization scheduling",           "eng",   "Engineering",        "#fb923c"),
    ("reliability failure mode maintenance prognostics",         "eng",   "Engineering",        "#fb923c"),
    ("geotechnical soil foundation seismic earthquake",          "eng",   "Engineering",        "#fb923c"),
    ("civil infrastructure concrete bridge failure crack",       "eng",   "Engineering",        "#fb923c"),

    # ── Psychology (15 topics) ────────────────────────────────────────────────
    ("cognitive psychology memory attention decision bias",      "psych", "Psychology",         "#f472b6"),
    ("social psychology conformity group identity",              "psych", "Psychology",         "#f472b6"),
    ("personality Big Five trait measurement validity",          "psych", "Psychology",         "#f472b6"),
    ("developmental psychology child attachment parenting",      "psych", "Psychology",         "#f472b6"),
    ("psychotherapy CBT outcome efficacy trial",                 "psych", "Psychology",         "#f472b6"),
    ("motivation self-determination intrinsic goal",             "psych", "Psychology",         "#f472b6"),
    ("emotion regulation affect wellbeing resilience",           "psych", "Psychology",         "#f472b6"),
    ("autism spectrum ASD social cognition theory of mind",      "psych", "Psychology",         "#f472b6"),
    ("addiction substance reward craving treatment",             "psych", "Psychology",         "#f472b6"),
    ("language acquisition bilingual second language",           "psych", "Psychology",         "#f472b6"),
    ("social media screen time mental health",                   "psych", "Psychology",         "#f472b6"),
    ("implicit bias stereotype threat unconscious",              "psych", "Psychology",         "#f472b6"),
    ("ADHD executive function inhibition attention",             "psych", "Psychology",         "#f472b6"),
    ("stress cortisol HPA axis chronic health",                  "psych", "Psychology",         "#f472b6"),
    ("moral judgement altruism cooperation trust",               "psych", "Psychology",         "#f472b6"),

    # ── Astronomy (15 topics) ─────────────────────────────────────────────────
    ("galaxy formation evolution stellar feedback",              "astro", "Astronomy",          "#60a5fa"),
    ("black hole accretion disk jet AGN quasar",                 "astro", "Astronomy",          "#60a5fa"),
    ("cosmic large scale structure simulation N-body",           "astro", "Astronomy",          "#60a5fa"),
    ("exoplanet atmosphere biosignature JWST transit",           "astro", "Astronomy",          "#60a5fa"),
    ("dark matter halo simulation abundance",                    "astro", "Astronomy",          "#60a5fa"),
    ("stellar evolution nucleosynthesis supernova",              "astro", "Astronomy",          "#60a5fa"),
    ("reionization epoch first stars galaxy Lyman",              "astro", "Astronomy",          "#60a5fa"),
    ("fast radio burst FRB dispersion measure",                  "astro", "Astronomy",          "#60a5fa"),
    ("gravitational lensing weak strong shear",                  "astro", "Astronomy",          "#60a5fa"),
    ("compact binary merger neutron star kilonova",              "astro", "Astronomy",          "#60a5fa"),
    ("stellar spectroscopy abundance chemical evolution",        "astro", "Astronomy",          "#60a5fa"),
    ("pulsar timing gravitational wave background",              "astro", "Astronomy",          "#60a5fa"),
    ("solar system formation planetary migration",               "astro", "Astronomy",          "#60a5fa"),
    ("interferometry VLBI radio telescope imaging",              "astro", "Astronomy",          "#60a5fa"),
    ("multi-messenger astronomy electromagnetic counterpart",    "astro", "Astronomy",          "#60a5fa"),

    # ── Education (10 topics) ─────────────────────────────────────────────────
    ("active learning student engagement achievement",           "edu",   "Education",          "#a3e635"),
    ("online learning MOOC e-learning platform dropout",        "edu",   "Education",          "#a3e635"),
    ("educational technology AI tutoring intelligent system",    "edu",   "Education",          "#a3e635"),
    ("mathematics education problem solving algebra",            "edu",   "Education",          "#a3e635"),
    ("reading literacy phonics comprehension",                   "edu",   "Education",          "#a3e635"),
    ("STEM science education interest motivation identity",      "edu",   "Education",          "#a3e635"),
    ("teacher professional development classroom practice",      "edu",   "Education",          "#a3e635"),
    ("formative assessment feedback metacognition",              "edu",   "Education",          "#a3e635"),
    ("special education disability inclusion support",           "edu",   "Education",          "#a3e635"),
    ("higher education equity access completion dropout",        "edu",   "Education",          "#a3e635"),
]

CACHE_DIR     = os.path.join(os.path.dirname(__file__), ".cache")
PAPERS_JSON   = os.path.join(CACHE_DIR, "papers.json")
PROGRESS_JSON = os.path.join(CACHE_DIR, "progress.json")
EMBED_NPY     = os.path.join(CACHE_DIR, "embeddings.npy")
COORDS_NPY    = os.path.join(CACHE_DIR, "coords.npy")
STARS_JSON    = os.path.join(os.path.dirname(__file__), "stars.json")


def main():
    parser = argparse.ArgumentParser(description="search-comete data pipeline")
    parser.add_argument("--limit",      type=int, default=200,  help="Papers per topic (default 200)")
    parser.add_argument("--skip-fetch", action="store_true",    help="Load papers from cache")
    parser.add_argument("--skip-embed", action="store_true",    help="Load embeddings from cache")
    parser.add_argument("--skip-umap",  action="store_true",    help="Load 3D coords from cache")
    parser.add_argument("--skip-index", action="store_true",    help="Skip Elasticsearch indexing")
    parser.add_argument("--use-arxiv",  action="store_true",    help="Use arXiv instead of OpenAlex")
    parser.add_argument("--use-ss",     action="store_true",    help="Use Semantic Scholar instead of OpenAlex")
    parser.add_argument("--resume",     action="store_true",    help="Resume interrupted fetch from last completed topic")
    parser.add_argument("--clusters",   type=str, default=None, help="Only fetch these clusters, e.g. --clusters ml,bio,phys")
    parser.add_argument("--es-host",    default=os.getenv("ES_HOST", "http://localhost:9200"))
    args = parser.parse_args()

    os.makedirs(CACHE_DIR, exist_ok=True)

    topics = TOPICS
    if args.clusters:
        wanted = set(c.strip() for c in args.clusters.split(","))
        topics = [t for t in TOPICS if t[1] in wanted]
        print(f"\n  Filtering to clusters: {wanted} ({len(topics)} topics)")

    print("\nsearch-comete pipeline")
    print("=" * 60)
    print(f"  Topics : {len(topics)}")
    print(f"  Limit  : {args.limit} papers/topic")
    print(f"  Max    : ~{len(topics) * args.limit:,} papers")

    if args.use_arxiv:
        fetch_fn, source = fetch_arxiv, "arXiv"
    elif args.use_ss:
        fetch_fn, source = fetch_semantic_scholar, "Semantic Scholar"
        print("  ⚠ Semantic Scholar rate-limits hard - OpenAlex is recommended for bulk runs")
    else:
        fetch_fn, source = fetch_openalex, "OpenAlex"
        if email := os.getenv("OPENALEX_EMAIL", ""):
            print(f"  OpenAlex polite pool: {email}")
        else:
            print("  Tip: set OPENALEX_EMAIL=your@email.com for polite pool")
    print(f"  Source : {source}")
    print("=" * 60)

    # ── 1. Fetch ──────────────────────────────────────────────────────────────
    if args.skip_fetch and os.path.exists(PAPERS_JSON):
        print("\n[1/5] Loading papers from cache…")
        with open(PAPERS_JSON) as f:
            cached = json.load(f)
        papers        = [c["paper"]   for c in cached]
        cluster_infos = [c["cluster"] for c in cached]
        counts = Counter(c["id"] for c in cluster_infos)
        print(f"  {len(papers):,} papers | {len(counts)} clusters")
    else:
        print(f"\n[1/5] Fetching papers…")
        completed = {}
        if args.resume and os.path.exists(PROGRESS_JSON):
            with open(PROGRESS_JSON) as f:
                completed = json.load(f)
            print(f"  Resuming from {len(completed)}/{len(topics)} completed topics")

        papers, cluster_infos = [], []
        for key, result in completed.items():
            for p, c in zip(result["papers"], result["clusters"]):
                papers.append(p)
                cluster_infos.append(c)

        for i, (query, cid, clabel, ccolor) in enumerate(topics):
            topic_key = f"{i}_{cid}"
            if topic_key in completed:
                n = len(completed[topic_key]["papers"])
                print(f"  [{i+1:03d}/{len(topics)}] [{cid:6s}] ✓ {n}")
                continue

            print(f"  [{i+1:03d}/{len(topics)}] [{cid:6s}] {query[:52]}…", end="", flush=True)
            fetched        = fetch_fn(query, limit=args.limit)
            cl             = {"id": cid, "label": clabel, "color": ccolor}
            topic_clusters = [cl] * len(fetched)
            papers.extend(fetched)
            cluster_infos.extend(topic_clusters)
            print(f" → {len(fetched)}")

            completed[topic_key] = {"papers": fetched, "clusters": topic_clusters}
            with open(PROGRESS_JSON, "w") as f:
                json.dump(completed, f)

        papers, cluster_infos = deduplicate(papers, cluster_infos)
        counts = Counter(c["id"] for c in cluster_infos)
        print(f"\n  Total unique: {len(papers):,} papers across {len(counts)} clusters")
        for cid, n in sorted(counts.items()):
            print(f"    {cid:8s}: {n:,}")

        with open(PAPERS_JSON, "w") as f:
            json.dump([{"paper": p, "cluster": c} for p, c in zip(papers, cluster_infos)], f)
        print(f"  Saved → {PAPERS_JSON}")

    # ── 2. Embed ──────────────────────────────────────────────────────────────
    if args.skip_embed and os.path.exists(EMBED_NPY):
        print("\n[2/5] Loading embeddings from cache…")
        embeddings = np.load(EMBED_NPY)
        print(f"  Shape: {embeddings.shape}")
    else:
        print("\n[2/5] Generating embeddings…")
        embeddings = embed_papers(papers, load_model())
        np.save(EMBED_NPY, embeddings)

    # ── 3. UMAP ───────────────────────────────────────────────────────────────
    if args.skip_umap and os.path.exists(COORDS_NPY):
        print("\n[3/5] Loading 3D coords from cache…")
        coords_3d = np.load(COORDS_NPY)
    else:
        print("\n[3/5] Running UMAP…")
        coords_3d = run_umap(embeddings)
        np.save(COORDS_NPY, coords_3d)

    # ── 4. Export stars.json ──────────────────────────────────────────────────
    print("\n[4/5] Building documents…")
    docs  = build_docs(papers, cluster_infos, embeddings, coords_3d)
    stars = [{
        "id":      d["id"],     "title":   d["title"],
        "authors": d["authors"],"year":    d["year"],
        "cite":    d["citations"], "cluster": d["cluster_id"],
        "color":   d["cluster_color"],
        "x":       round(d["pos_x"], 4),
        "y":       round(d["pos_y"], 4),
        "z":       round(d["pos_z"], 4),
    } for d in docs]

    with open(STARS_JSON, "w") as f:
        json.dump(stars, f, separators=(",", ":"))
    size_kb = os.path.getsize(STARS_JSON) // 1024
    counts  = Counter(s["cluster"] for s in stars)
    print(f"  Exported {len(stars):,} stars → {STARS_JSON} ({size_kb} KB)")
    for cid, n in sorted(counts.items()):
        print(f"    {cid:8s}: {n:,}")

    # ── 5. Elasticsearch ──────────────────────────────────────────────────────
    if not args.skip_index:
        print(f"\n[5/5] Indexing → Elasticsearch ({args.es_host})…")
        try:
            api_key = os.getenv("ES_API_KEY", "")
            if api_key:
                print(f"  Using API key authentication")
                es = Elasticsearch(args.es_host, api_key=api_key)
            else:
                es = Elasticsearch(args.es_host)
            es.info()
            setup_index(es)
            bulk_index(es, docs)
            print(f"  Total in index: {es.count(index='knowledge_galaxy')['count']:,}")
        except Exception as e:
            print(f"  ES unavailable: {e}")
            print("  stars.json still exported - frontend can use it directly")
    else:
        print("\n[5/5] Skipping Elasticsearch (--skip-index)")

    print(f"\n✓ Done - {len(docs):,} papers")
    print(f"\n  cp pipeline/stars.json frontend/public/stars.json")
    print(f"  Ctrl+Shift+R in browser")


if __name__ == "__main__":
    main()