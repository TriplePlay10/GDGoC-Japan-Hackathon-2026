'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Kaisei_Decol, M_PLUS_1p } from 'next/font/google';

// Firebase用のインポート
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';
import { auth, db, storage } from '../lib/firebase'; 

const kaiseiDecol = Kaisei_Decol({
  weight: ['700'], 
  preload: false,
  display: 'swap',
});

const mPlusRounded = M_PLUS_1p({
  weight: ['800'], 
  preload: false,
  display: 'swap',
});

const DESC_PINK = '#ff4da6'; 
const DESC_BLUE = '#00d8ff'; 

interface Note {
  pitch: string;
  color: string;
  x: number;
  y: number;
  id: string;
}

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  type: 'marker' | 'eraser';
  path: Point[];
}

function makeId() {
  return Math.random().toString(36).slice(2, 11);
}

// 汎用UIコンポーネント: 数値調整用のスライダー（＋/−ボタン付き）
function SliderWithButtons({
  label, value, min, max, step, onChange, formatValue, accentColor = "accent-blue-600"
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (val: number) => void; formatValue?: (val: number) => string; accentColor?: string;
}) {
  const handleAdd = () => onChange(Math.min(max, Math.round((value + step) * 1000) / 1000));
  const handleSub = () => onChange(Math.max(min, Math.round((value - step) * 1000) / 1000));

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs font-bold text-slate-500">
        <span>{label}</span>
        <span className="text-slate-700">{formatValue ? formatValue(value) : value}</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={handleSub} className="w-8 h-8 flex shrink-0 items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full font-bold shadow-sm active:scale-95 transition-transform">−</button>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className={`flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer ${accentColor}`} />
        <button onClick={handleAdd} className="w-8 h-8 flex shrink-0 items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full font-bold shadow-sm active:scale-95 transition-transform">＋</button>
      </div>
    </div>
  );
}

export default function DoremiruPage() {
  // アプリケーション全体の主要な状態管理
  const [isChecking, setIsChecking] = useState(true);
  const [hasStarted, setHasStarted] = useState(false);
  const [isTopLoaded, setIsTopLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const savedView = sessionStorage.getItem('doremiru_view');
    if (savedView === 'tool') {
      setHasStarted(true);
    }
  }, []);

  // 画面遷移ハンドラー
  const goToTool = () => {
    setHasStarted(true);
    // すでに画像がある状態で戻る場合は、画像サイズの自動調整（フィット）をスキップする
    if (imageSrc) {
      skipFitRef.current = true;
    }
    sessionStorage.setItem('doremiru_view', 'tool');
  };

  const goToTop = () => {
    setHasStarted(false);
    sessionStorage.setItem('doremiru_view', 'top');
  };

  const TREBLE_COLOR = 'rgba(244, 114, 182, 0.9)'; 
  const BASS_COLOR = 'rgba(56, 189, 248, 0.9)';   

  const logoText = [
    { char: 'ド', color: '#86cecb' },
    { char: 'レ', color: '#ebd3cf' },
    { char: 'ミ', color: '#ffd98c' },
    { char: 'え', color: hasStarted ? '#000000' : '#ffffff' },
    { char: 'る', color: hasStarted ? '#000000' : '#ffffff' },
  ];

  // キャンバス・画像解析に関する状態群
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [originalFileName, setOriginalFileName] = useState<string>('score'); 
  const [notes, setNotes] = useState<Note[]>([]); // 検出または追加された音符データ
  const [status, setStatus] = useState('画像をアップロードしてください');
  const [clef, setClef] = useState<'treble' | 'bass'>('treble'); 
  const [mode, setMode] = useState<'auto' | 'erase_marker' | 'manual_add' | 'manual_delete'>('auto');
  
  // 描画パラメータ（五線の位置、間隔、表示倍率など）
  const [scale, setScale] = useState<number>(1);
  const [hoverPos, setHoverPos] = useState<Point | null>(null);
  const [previewPos, setPreviewPos] = useState<Point | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]); // ユーザーが描いたマーカーの軌跡
  const [currentPath, setCurrentPath] = useState<Point[]>([]);
  const [isPainting, setIsPainting] = useState(false);
  const [staffTop, setStaffTop] = useState(200);
  const [spacing, setSpacing] = useState(15);
  const [threshold, setThreshold] = useState(39);
  const [imageDim, setImageDim] = useState(50); 

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null); 

  const skipFitRef = useRef(false);

  // [Firebase] クラウドからユーザーの編集データと画像URLを復元する
  const loadNotesFromCloud = useCallback(async (uid: string) => {
    try {
      setStatus('データを復元中...');
      const docRef = doc(db, "user_notes", uid);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.savedImageSrc) setImageSrc(data.savedImageSrc);
        if (data.notes) setNotes(data.notes);
        if (data.staffTop) setStaffTop(data.staffTop);
        if (data.spacing) setSpacing(data.spacing);
        
        if (data.scale) {
          setScale(data.scale);
          skipFitRef.current = true; 
        }
        
        if (data.clef) setClef(data.clef);
        if (data.mode) setMode(data.mode);
        if (data.threshold !== undefined) setThreshold(data.threshold);
        if (data.imageDim !== undefined) setImageDim(data.imageDim);
        
        setStatus('前回の状態を読み込みました');
      } else {
        setStatus('画像をアップロードしてください');
      }
    } catch (error) {
      console.error("読み込みエラー:", error);
      setStatus('復元に失敗しました');
    } finally {
      setIsChecking(false);
    }
  }, []);

  // [Firebase] 現在の進捗をクラウドに保存する
  const saveNotesToCloud = async () => {
    const user = auth.currentUser;
    if (!user) { setStatus('エラー：ログインしていません'); return; }
    if (!imageSrc) { setStatus('エラー：保存する画像がありません'); return; }
    
    try {
      let imageUrl = imageSrc; 

      // DataURL形式の場合はStorageにアップロードしてURLを取得する
      if (imageSrc.startsWith('data:')) {
        setStatus('進捗をセーブ中...');
        const storageRef = ref(storage, `user_images/${user.uid}/last_score.png`);
        await uploadString(storageRef, imageSrc, 'data_url');
        imageUrl = await getDownloadURL(storageRef);
      }

      setStatus('設定データを保存中...');
      await setDoc(doc(db, "user_notes", user.uid), {
        notes: notes, 
        staffTop: staffTop, 
        spacing: spacing, 
        scale: scale,
        clef: clef,
        mode: mode,
        threshold: threshold,
        imageDim: imageDim,
        savedImageSrc: imageUrl, 
        updatedAt: new Date().toISOString()
      });
      setStatus('セーブされました');
    } catch (error: any) {
      console.error("セーブエラー:", error);
      if (error.code === 'storage/unauthorized') {
        setStatus('セーブ失敗：サイズ制限または形式エラー');
      } else {
        setStatus('セーブに失敗しました');
      }
    }
  };

  // 全データの初期化　クラウドデータも
  const handleFullReset = async () => {
    if (window.confirm('現在の編集データと保存データを全て消去します\n完全に初期状態に戻しますか？\n（この操作は取り消せません）')) {
      setStatus('データを消去中...');
      const user = auth.currentUser;
      
      if (user) {
        try {
          await deleteDoc(doc(db, "user_notes", user.uid));
        } catch (error) {
          console.error("削除エラー:", error);
        }
      }

      setImageSrc(null);
      setOriginalFileName('score');
      setNotes([]);
      setStrokes([]);
      setCurrentPath([]);
      setClef('treble');
      setMode('auto');
      setScale(1);
      setStaffTop(200);
      setSpacing(15);
      setThreshold(39);
      setImageDim(50);
      setHoverPos(null);
      setPreviewPos(null);
      
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      setStatus('リセットしました。新しい楽譜画像を読み込んでください。');
    }
  };

  //アプリ起動時の匿名ログインとデータ復元のトリガー
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        loadNotesFromCloud(user.uid);
      } else {
        signInAnonymously(auth).catch((error) => {
          console.error("匿名ログイン失敗:", error);
          setIsChecking(false);
        });
      }
    });
    return () => unsubscribe();
  }, [loadNotesFromCloud]);

  useEffect(() => {
    if (!hasStarted && !isChecking) {
      setIsTopLoaded(false);
      const timer = setTimeout(() => setIsTopLoaded(true), 50);
      return () => clearTimeout(timer);
    }
  }, [hasStarted, isChecking]);

  // 画像が画面幅を超える場合、コンテナに収まるようにスケールを自動調整
  const fitToContainer = useCallback(() => {
    if (!imageRef.current || !containerRef.current) return;
    const imgWidth = imageRef.current.width;
    const containerWidth = containerRef.current.clientWidth;
    if (imgWidth > containerWidth) setScale((containerWidth / imgWidth) * 0.98); 
    else setScale(1);
  }, []);

  // [UI制御] ズーム（スケール）を考慮した正確なマウス座標をキャンバス上から取得
  const getMousePos = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  // 操作可能なY座標（五線の周辺のみ）を制限する
  const isAllowedY = useCallback((y: number) => {
    const margin = spacing * 5;
    return y >= (staffTop - margin) && y <= (staffTop + (spacing * 4) + margin);
  }, [staffTop, spacing]);

  // コア　Y座標から音階（ドレミ...）を判定・計算する
  // ユーザーが設定した五線の一番上の線（staffTop）と間隔（spacing）を基準にステップ数を算出
  const getPitchInfo = useCallback((y: number, currentClef: 'treble' | 'bass') => {
    const step = Math.round((y - staffTop) / (spacing / 2));
    const treblePitches = ['ファ', 'ミ', 'レ', 'ド', 'シ', 'ラ', 'ソ'];
    const bassPitches = ['ラ', 'ソ', 'ファ', 'ミ', 'レ', 'ド', 'シ'];
    const pitches = currentClef === 'treble' ? treblePitches : bassPitches;
    const pitchName = pitches[((step % 7) + 7) % 7];
    return { pitchName, color: currentClef === 'treble' ? TREBLE_COLOR : BASS_COLOR, snappedY: staffTop + step * (spacing / 2) };
  }, [staffTop, spacing]);

  //アップロードされた画像ファイルの読み込み処理（File ReaderAPIを使用）
  const processFile = (file: File) => {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setStatus('エラー：JPG, PNG, WebP形式の画像を選択してください');
      return;
    }

    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      setStatus('エラー：画像サイズは10MB以下にしてください');
      return;
    }

    setOriginalFileName(file.name.replace(/\.[^/.]+$/, ""));
    const reader = new FileReader();
    reader.onload = (ev) => {
      skipFitRef.current = false; 
      setImageSrc(ev.target?.result as string);
      setNotes([]); setStrokes([]); setCurrentPath([]);
      setStatus('五線を合わせてから、操作を選んでください');
    };
    reader.readAsDataURL(file);
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  //キャンバス全体を再レンダリングする
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // マーカー/消しゴムの軌跡を描画
    const drawStroke = (path: Point[], type: 'marker' | 'eraser') => {
      if (path.length === 0) return;
      ctx.globalCompositeOperation = type === 'eraser' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = type === 'eraser' ? 'rgba(0,0,0,1)' : 'rgba(255, 255, 0, 0.42)';
      ctx.lineWidth = Math.max(20, spacing * 1.5);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y);
      if (path.length === 1) ctx.lineTo(path[0].x + 0.01, path[0].y + 0.01);
      else path.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    };

    strokes.forEach(s => drawStroke(s.path, s.type));
    if (isPainting && (mode === 'auto' || mode === 'erase_marker')) {
      drawStroke(currentPath, mode === 'auto' ? 'marker' : 'eraser');
    }

    // 五線の補助線と背景の暗転を描画
    ctx.globalCompositeOperation = 'destination-over';
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.9)'; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const y = staffTop + i * spacing;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    const margin = spacing * 5;
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.6)'; ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(0, staffTop - margin); ctx.lineTo(canvas.width, staffTop - margin); ctx.stroke();
    ctx.setLineDash([]);

    if (imageDim > 0) {
      ctx.fillStyle = `rgba(30, 41, 59, ${imageDim / 100})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    // 解析された（または手動追加された）音符マーカーとテキストを描画
    notes.forEach((n) => {
      let drawColor = n.color;
      if (mode === 'manual_delete' && hoverPos && Math.sqrt((n.x - hoverPos.x)**2 + (n.y - hoverPos.y)**2) < 15) {
        drawColor = 'rgba(249, 115, 22, 1)'; 
      }
      ctx.fillStyle = drawColor; ctx.beginPath(); ctx.arc(n.x, n.y, 8.9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'black'; ctx.lineWidth = 2; ctx.stroke();
      if (n.pitch) {
        ctx.font = `bold 20px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'white';
        ctx.fillText(n.pitch, n.x + 17, n.y);
      }
    });

    if (mode === 'manual_add' && previewPos) {
      const { pitchName } = getPitchInfo(previewPos.y, clef);
      ctx.globalAlpha = 0.8; ctx.fillStyle = 'rgba(250, 204, 21, 0.9)'; ctx.beginPath(); ctx.arc(previewPos.x, previewPos.y, 8.9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = `bold 20px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
      ctx.fillText(pitchName, previewPos.x + 17, previewPos.y); ctx.globalAlpha = 1.0;
    }
  }, [strokes, currentPath, notes, spacing, staffTop, hoverPos, previewPos, mode, clef, imageDim, getPitchInfo]);

  useEffect(() => {
    if (!hasStarted || !imageSrc) return;
    
    const img = new Image();
    img.crossOrigin = "anonymous"; 
    
    img.onload = () => {
      if (!canvasRef.current) return;
      canvasRef.current.width = img.width;
      canvasRef.current.height = img.height;
      imageRef.current = img;
      
      if (!skipFitRef.current) {
        fitToContainer();
      }
      
      render();
    };

    img.onerror = () => {
      console.warn("CORSを回避して画像を表示します");
      const fallbackImg = new Image();
      fallbackImg.onload = () => {
        if (!canvasRef.current) return;
        canvasRef.current.width = fallbackImg.width;
        canvasRef.current.height = fallbackImg.height;
        imageRef.current = fallbackImg;
        
        if (!skipFitRef.current) {
          fitToContainer();
        }
        
        render();
      };
      fallbackImg.src = imageSrc;
    };

    img.src = imageSrc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc, hasStarted, fitToContainer]);

  useEffect(() => { render(); }, [render]);

  useEffect(() => {
    if (hasStarted && imageSrc && imageRef.current && canvasRef.current) {
      if (canvasRef.current.width !== imageRef.current.width) {
        canvasRef.current.width = imageRef.current.width;
        canvasRef.current.height = imageRef.current.height;
        if (!skipFitRef.current) {
          fitToContainer();
        }
        render();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStarted, imageSrc, fitToContainer]);

  // [画像解析アルゴリズム] ユーザーが塗ったマーカー範囲のピクセルを走査し、音符（黒いかたまり）を検出する
  const analyze = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || strokes.length === 0) return;

    setStatus('音符（黒塗り＆白抜き）を解析中...');

    try {
      // 解析用に画像を元の状態で描画するオフスクリーンキャンバス
      const sctx = document.createElement('canvas').getContext('2d')!;
      sctx.canvas.width = canvas.width; sctx.canvas.height = canvas.height;
      sctx.drawImage(img, 0, 0);

      // マスク（探索範囲）を定義するためのオフスクリーンキャンバス
      const mctx = document.createElement('canvas').getContext('2d')!;
      mctx.canvas.width = canvas.width; mctx.canvas.height = canvas.height;

      const drawMaskStroke = (path: Point[], type: 'marker' | 'eraser') => {
        if (path.length === 0) return;
        mctx.globalCompositeOperation = type === 'eraser' ? 'destination-out' : 'source-over';
        mctx.strokeStyle = 'rgba(0,0,0,1)';
        mctx.lineWidth = Math.max(20, spacing * 1.5);
        mctx.lineCap = 'round'; mctx.lineJoin = 'round';
        mctx.beginPath(); mctx.moveTo(path[0].x, path[0].y);
        if (path.length === 1) mctx.lineTo(path[0].x + 0.01, path[0].y + 0.01);
        else path.forEach((p) => mctx.lineTo(p.x, p.y));
        mctx.stroke();
      };
      strokes.forEach(s => drawMaskStroke(s.path, s.type));

      //1ピクセル単位で明度をチェックするため画像データを取得
      const data = sctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const mdata = mctx.getImageData(0, 0, canvas.width, canvas.height).data;
      
      // 音符のおおよそのサイズを計算　五線の間隔基準
      const noteW = Math.max(3, Math.floor(spacing * 1.3));
      const noteH = Math.max(3, Math.floor(spacing * 0.9));
      const boxArea = noteW * noteH;
      
      const halfW = Math.floor(noteW / 2);
      const halfH = Math.floor(noteH / 2);
      const coreHalfW = Math.floor(halfW * 0.5);
      const coreHalfH = Math.floor(halfH * 0.5);

      const detectedCandidates: {x: number, y: number, density: number}[] = [];

      // ユーザーが描画したストローク（探索範囲）ごとに走査
      for (const stroke of strokes) {
        if (stroke.type === 'eraser') continue; 
        const path = stroke.path;
        if (path.length === 0) continue;

        // 計算コスト削減のため、ストロークのバウンディングボックス（矩形範囲）内のみを探索
        const minX = Math.max(0, Math.floor(Math.min(...path.map(p => p.x)) - spacing * 2));
        const maxX = Math.min(canvas.width, Math.ceil(Math.max(...path.map(p => p.x)) + spacing * 2));
        const minY = Math.max(0, Math.floor(Math.min(...path.map(p => p.y)) - spacing * 2));
        const maxY = Math.min(canvas.height, Math.ceil(Math.max(...path.map(p => p.y)) + spacing * 2));

        const width = maxX - minX;
        const height = maxY - minY;

        // 指定範囲のピクセルの二値化（しきい値 threshold より暗いピクセルを1、それ以外を0とする）
        const isBlack = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const globalX = minX + x;
            const globalY = minY + y;
            const i = (globalY * canvas.width + globalX) * 4;
            
            if (mdata[i + 3] === 0) continue; // マスク範囲外ならスキップ

            const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
            if (brightness < threshold) {
              isBlack[y * width + x] = 1;
            }
          }
        }

        // 音符の中心点となる候補を探すフィルタリング処理
        for (let y = halfH; y < height - halfH; y += 2) { 
          for (let x = halfW; x < width - halfW; x += 2) {
            let totalBlack = 0;
            let coreBlack = 0;

            for (let dy = -halfH; dy <= halfH; dy++) {
              for (let dx = -halfW; dx <= halfW; dx++) {
                if (isBlack[(y + dy) * width + (x + dx)] === 1) {
                  totalBlack++;
                  if (Math.abs(dx) <= coreHalfW && Math.abs(dy) <= coreHalfH) {
                    coreBlack++;
                  }
                }
              }
            }

            const minTotalBlack = boxArea * 0.2;
            if (totalBlack < minTotalBlack) continue;

            const outerBlack = totalBlack - coreBlack;
            const solidScore = totalBlack;
            // 白抜き音符（中心が白く周囲が黒い）にも対応するためのスコア計算
            const hollowScore = (outerBlack * 1.5) - (coreBlack * 2.0);
            const score = Math.max(solidScore, hollowScore);
            const minScore = boxArea * 0.4;

            if (score >= minScore) {
              detectedCandidates.push({ x: minX + x, y: minY + y, density: score });
            }
          }
        }
      }

      // 重複検出を防ぐため、密度の高い順にソートし、近接する候補を除外（非極大値抑制に似た処理）
      detectedCandidates.sort((a, b) => b.density - a.density);
      const finalNotes: Note[] = [];
      const minDistance = spacing * 1.1; 

      for (const cand of detectedCandidates) {
        const isTooClose = finalNotes.some(n => {
          const dx = n.x - cand.x;
          const dy = n.y - cand.y;
          return Math.sqrt(dx * dx + dy * dy) < minDistance;
        });

        if (!isTooClose) {
          const { pitchName, color, snappedY } = getPitchInfo(cand.y, clef);
          finalNotes.push({ pitch: pitchName, color, x: cand.x, y: snappedY, id: makeId() });
        }
      }

      setNotes(prev => [...prev, ...finalNotes]);
      setStrokes([]); setCurrentPath([]); 
      
      if (finalNotes.length === 0) {
        setStatus('音符が見つかりませんでした。感度や間隔(S)を調整してください。');
      } else {
        setStatus(`音符を ${finalNotes.length}個 検出しました`);
      }
    } catch (e) {
      console.error(e);
      setStatus("セキュリティ制限により解析できませんでした。画像を再度読み込んでください。");
    }
  };

  const finishPaint = useCallback(() => {
    setIsPainting(false);
    setCurrentPath(prev => {
      if (prev.length > 0) {
        setStrokes(old => [...old, { type: mode === 'erase_marker' ? 'eraser' : 'marker', path: prev }]);
      }
      return [];
    });
  }, [mode]);

  // [画像エクスポート] 元画像の上に音階テキストを合成し、PNGファイルとしてダウンロードさせる
  const handleSave = () => {
    const img = imageRef.current;
    if (!img) { setStatus('保存する画像がありません'); return; }

    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = img.width;
    offscreenCanvas.height = img.height;
    const ctx = offscreenCanvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(img, 0, 0);

    const FIXED_FONT_SIZE = 20;
    const FIXED_TEXT_OFFSET = 17;

    notes.forEach((n) => {
      if (n.pitch) {
        ctx.font = `bold ${FIXED_FONT_SIZE}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'white'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
        ctx.strokeText(n.pitch, n.x + FIXED_TEXT_OFFSET, n.y);
        ctx.fillStyle = n.color; ctx.fillText(n.pitch, n.x + FIXED_TEXT_OFFSET, n.y);
      }
    });

    const dataUrl = offscreenCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${originalFileName}_doremieru.png`; 
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    setStatus('画像を保存しました');
  };

  // --- マウス・タッチ操作のイベントハンドラー ---

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => { 
    const pos = getMousePos(e);
    if (mode === 'manual_delete') {
      const CLICK_RADIUS = 15;
      const clickedIdx = notes.findIndex(n => Math.sqrt((n.x - pos.x)**2 + (n.y - pos.y)**2) < CLICK_RADIUS);
      if (clickedIdx !== -1) {
        setNotes(prev => prev.filter((_, i) => i !== clickedIdx));
        setStatus('印を削除しました');
      }
      return;
    }
    if (mode === 'manual_add') {
      if (!isAllowedY(pos.y)) { setStatus('範囲外です'); return; }
      const { pitchName, color, snappedY } = getPitchInfo(pos.y, clef);
      setNotes(prev => [...prev, { pitch: pitchName, color, x: pos.x, y: snappedY, id: makeId() }]);
      setPreviewPos(null); setStatus(`${pitchName} を追加しました`);
      return;
    }
    if (!isAllowedY(pos.y)) return;
    setIsPainting(true); setCurrentPath([pos]); 
  };
  
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => { 
    const pos = getMousePos(e);
    setHoverPos(pos);
    if (mode === 'manual_add') {
      setPreviewPos(null); 
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      if (isAllowedY(pos.y)) {
        previewTimerRef.current = setTimeout(() => {
          const { snappedY } = getPitchInfo(pos.y, clef);
          setPreviewPos({ x: pos.x, y: snappedY });
        }, 300);
      }
    }
    if ((mode === 'auto' || mode === 'erase_marker') && isPainting) {
      if (!isAllowedY(pos.y)) { finishPaint(); return; }
      setCurrentPath(prev => [...prev, pos]); 
    }
  };
  
  const onMouseUp = () => finishPaint();
  const onMouseLeave = () => {
    setHoverPos(null); setPreviewPos(null);
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    finishPaint();
  };

  // --- UI レンダリング部分 ---

  if (isChecking) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 space-y-4">
        <div className="w-12 h-12 border-4 border-[#86cecb] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-white font-bold tracking-widest animate-pulse">読み込み中...</p>
      </div>
    );
  }

  if (!hasStarted) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 md:p-12 relative overflow-hidden font-sans">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#334155_1px,transparent_1px),linear-gradient(to_bottom,#334155_1px,transparent_1px)] bg-[size:40px_40px] opacity-30"></div>
        
        <div className="max-w-[1600px] w-full grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center relative z-10 flex-grow">
          <div className="lg:col-span-5 space-y-10 relative -top-[46px] left-5 md:left-14">
            <h1 className={`${kaiseiDecol.className} text-7xl md:text-[7rem] font-black tracking-widest drop-shadow-lg flex gap-1 md:gap-2 transition-all duration-1000 ease-out ${
              isTopLoaded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}>
              {logoText.map((item, index) => (
                <span key={index} style={{ color: item.color }}>{item.char}</span>
              ))}
            </h1>
            
            <div className={`space-y-6 text-slate-300 transition-all duration-1000 ease-out delay-300 ${
              isTopLoaded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}>
              <p className={`${mPlusRounded.className} text-4xl md:text-4xl font-bold tracking-wider leading-relaxed text-white`}>
                <span style={{ color: DESC_PINK }}>『ドレミ』</span>が<span style={{ color: DESC_BLUE }}>『みえる』</span><br/>自動譜読みツール
              </p>
              
              <div className="text-xl md:text-1xl leading-relaxed text-slate-300 space-y-3 font-medium tracking-wide">
                <p><span className="text-[#86cecb] font-black mr-2">✓</span>マーカーで塗ったところの音階を自動で表示</p>
                <p><span className="text-[#86cecb] font-black mr-2">✓</span>お手持ちの楽譜画像を読み込んで表示</p>
              </div>
            </div>
            
            <div className={`transition-all duration-1000 ease-out delay-500 ${
              isTopLoaded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}>
              <button 
                onClick={goToTool}
                className="px-9 py-4 text-2xl md:text-1xl font-bold text-white bg-blue-600 rounded-full shadow-lg hover:bg-blue-700 transition-all duration-300 active:scale-95 tracking-widest"
              >
                始める
              </button>
            </div>
          </div>

          <div className="lg:col-span-7 relative hidden lg:block top-[213px] left-[30px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img 
              src="/doremieru_index.png" 
              alt="ドレミえるの操作画面" 
              className={`w-[130%] max-w-none h-auto block rounded-3xl shadow-2xl transition-all duration-1000 ease-out delay-700 ${
                isTopLoaded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            />
          </div>
        </div>

        <div className={`absolute bottom-4 left-0 w-full text-center z-20 px-4 transition-all duration-1000 ease-out delay-1000 ${
          isTopLoaded ? 'opacity-100' : 'opacity-0'
        }`}>
          <p className="text-[11px] md:text-xs text-slate-500/80 font-medium tracking-wide">
            ※進行状況のセーブ機能をご利用の際、楽譜画像はクラウド上に保存されます。<br className="md:hidden" />
            管理者がシステムの保守・トラブルシューティング以外の目的で画像を閲覧・悪用することはありません。
          </p>
        </div>

      </div>
    );
  }

  return (
    <main 
      className="min-h-screen bg-slate-50 p-2 md:p-4 font-sans text-slate-900 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-blue-500/20 border-8 border-blue-500 border-dashed rounded-3xl flex items-center justify-center pointer-events-none">
          <div className="bg-white px-10 py-6 rounded-2xl shadow-2xl flex flex-col items-center">
            <span className="text-6xl mb-4">📥</span>
            <p className="text-2xl font-bold text-blue-600">ここに画像をドロップして読み込み</p>
          </div>
        </div>
      )}

      <div className="w-full mx-auto space-y-4">
        
        <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h1 
            onClick={goToTop}
            className={`${kaiseiDecol.className} text-4xl font-black tracking-tighter cursor-pointer hover:opacity-80 transition-opacity`}
            title="トップページへ戻る"
          >
            {logoText.map((item, index) => (
              <span key={index} style={{ color: item.color }}>{item.char}</span>
            ))}
          </h1>
          
          <div className="flex flex-wrap gap-4 items-center">
            <button
              onClick={handleSave}
              disabled={!imageSrc}
              className={`px-5 py-2 text-sm font-bold rounded-full transition-all border ${
                imageSrc 
                  ? 'bg-green-500 text-white border-green-400 hover:bg-green-600 active:scale-95 shadow-sm' 
                  : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
              }`}
            >
              画像を出力
            </button>

            <button 
              onClick={saveNotesToCloud} 
              className="px-5 py-2 text-sm font-bold text-blue-600 hover:bg-blue-50 rounded-full transition-colors border border-blue-200 shadow-sm"
            >
              進捗をセーブ
            </button>
            
            <button 
              onClick={() => { 
                if (window.confirm('本当につけた印を全て消去しますか？\n（※セーブする前なら、ページを読み込み直せば元に戻せます）')) {
                  setNotes([]); 
                  setStrokes([]); 
                  setCurrentPath([]); 
                  setStatus('印をリセットしました'); 
                }
              }} 
              className="px-5 py-2 text-sm font-bold text-red-500 hover:bg-red-50 rounded-full transition-colors border border-red-100 shadow-sm"
            >
              印をリセット
            </button>
          </div>
        </div>

        <div className="px-6 py-3 rounded-2xl bg-slate-900 flex items-center justify-center gap-3">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#86cecb] opacity-40"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#86cecb]"></span>
          </span>
          <span className="font-mono text-sm md:text-base font-semibold text-[#86cecb] tracking-wider">
            {status}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-white p-5 rounded-2xl shadow-sm space-y-6 border border-slate-200">
              
              <div className="space-y-3">
                <label className="text-[13px] font-bold text-slate-900 uppercase tracking-widest">
                  楽譜を読み込む
                </label>
                <input 
                  ref={fileInputRef}
                  type="file" 
                  accept=".jpg,.jpeg,.png,.webp" 
                  onChange={handleUpload} 
                  className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 transition-colors cursor-pointer" 
                />
              </div>

              <div className="space-y-3">
                <label className="text-[13px] font-bold text-slate-900 uppercase tracking-widest">操作モード</label>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setMode('auto')} className={`py-3 text-xs font-bold rounded-xl transition-all ${mode === 'auto' ? 'bg-yellow-400 text-slate-900 shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    🖍️ マーカーを引く
                  </button>
                  <button onClick={() => setMode('erase_marker')} className={`py-3 text-xs font-bold rounded-xl transition-all ${mode === 'erase_marker' ? 'bg-orange-400 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    🧽 マーカーを消す
                  </button>
                  <button onClick={() => setMode('manual_add')} className={`py-3 text-xs font-bold rounded-xl transition-all ${mode === 'manual_add' ? 'bg-blue-500 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    ➕ 印をつける
                  </button>
                  <button onClick={() => setMode('manual_delete')} className={`py-3 text-xs font-bold rounded-xl transition-all ${mode === 'manual_delete' ? 'bg-red-500 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    🗑️ 印を消す
                  </button>
                </div>
                
                {mode === 'auto' && (
                  <div className="pt-2">
                    <button onClick={analyze} className="w-full py-3 bg-blue-600 text-white rounded-xl font-black text-base shadow-md shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all">
                      音符を解析
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <label className="text-[13px] font-bold text-slate-900 uppercase tracking-widest">音部記号</label>
                <div className="flex bg-slate-100 p-1 rounded-xl">
                  <button onClick={() => setClef('treble')} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${clef === 'treble' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>ト音記号</button>
                  <button onClick={() => setClef('bass')} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${clef === 'bass' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>ヘ音記号</button>
                </div>
              </div>

              <div className="space-y-4">
                <label className="text-[13px] font-bold text-slate-900 uppercase tracking-widest">五線を合わせる</label>
                <SliderWithButtons label="位置 (Y)" value={staffTop} min={0} max={3000} step={1} onChange={setStaffTop} />
                <SliderWithButtons label="間隔 (S)" value={spacing} min={5} max={150} step={1} onChange={setSpacing} />
                
                <div className="pt-3 pb-1 border-t border-slate-100 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-[13px] font-bold text-slate-900 uppercase tracking-widest">表示サイズの調整</label>
                    <button 
                      onClick={fitToContainer} 
                      className="text-[10px] px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded font-bold transition-colors active:scale-95"
                    >
                      画面幅に合わせる
                    </button>
                  </div>
                  <SliderWithButtons
                    label="ズーム倍率"
                    value={scale} min={0.1} max={3.0} step={0.05}
                    onChange={setScale}
                    formatValue={v => `${Math.round(v * 100)}%`}
                  />
                </div>

                <SliderWithButtons label="背景の暗さ" value={imageDim} min={0} max={90} step={5} onChange={setImageDim} formatValue={v => `${v}%`} accentColor="accent-slate-500" />
              </div>

              {mode === 'auto' && (
                <div className="space-y-4 border-t border-slate-100 pt-4">
                  <label className="text-[13px] font-bold text-slate-900 uppercase tracking-widest">感度調整</label>
                  <SliderWithButtons label="黒さしきい値" value={threshold} min={0} max={220} step={1} onChange={setThreshold} accentColor="accent-slate-800" />
                </div>
              )}

              <div className="pt-6 border-t border-slate-100">
                <button
                  onClick={handleFullReset}
                  className="w-full py-3 rounded-xl font-bold text-sm tracking-widest text-red-500 bg-red-50 hover:bg-red-100 active:scale-95 transition-all border border-red-200"
                >
                  全てのデータをリセット
                </button>
              </div>

            </div>
          </div>

          <div className="lg:col-span-4">
            {imageSrc ? (
              <>
                <div className="bg-white rounded-3xl shadow-xl overflow-hidden border-4 border-white">
                  <div ref={containerRef} className="overflow-auto max-h-[85vh] bg-slate-200">
                  <canvas 
                    ref={canvasRef} 
                    onMouseDown={onMouseDown} 
                    onMouseMove={onMouseMove} 
                    onMouseUp={onMouseUp} 
                    onMouseLeave={onMouseLeave} 
                    style={{
                      width: canvasRef.current ? `${canvasRef.current.width * scale}px` : 'auto',
                      height: canvasRef.current ? `${canvasRef.current.height * scale}px` : 'auto'
                    }}
                    className={`mx-auto ${mode === 'auto' ? 'cursor-crosshair' : 'cursor-pointer'}`} 
                  />
                  </div>
                </div>
                <p className="mt-3 text-center text-xs text-slate-400 font-medium">
                  {mode === 'auto' 
                    ? '五線の周辺（上下の点線内）をなぞってマーカーを引きます' 
                    : mode === 'erase_marker'
                    ? 'ドラッグしてなぞった部分のマーカーを消去できます'
                    : mode === 'manual_add' 
                    ? '五線の周辺で0.3秒止まるとプレビューが表示され、クリックで追加します' 
                    : 'クリックで音符を削除します'}
                </p>
              </>
            ) : (
              <div className="h-full min-h-[60vh] flex flex-col items-center justify-center border-4 border-dashed border-slate-200 rounded-3xl bg-slate-50/50 relative">
                <div className="text-slate-300 text-6xl mb-4">🎵</div>
                <p className="text-slate-400 font-bold text-center">
                  左上のパネルから楽譜画像を選択するか<br/>
                  <span className="text-slate-500">ここに画像をドラッグ＆ドロップ</span>してください
                </p>
              </div>
            )}
          </div>

        </div>
      </div>
    </main>
  );
}