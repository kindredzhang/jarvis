#!/usr/bin/env python3
"""
摇滚乐编曲模板生成器 — Rock Arrangement Template Generator

生成一个结构化的编曲方案 Markdown 文件，可作为编曲起点。

Usage:
    python3 arrangement-template.py --title "歌名" --key E --bpm 120 --genre "classic-rock"
    python3 arrangement-template.py --title "无名" --key A --bpm 140 --genre punk --structure "intro,verse,chorus,verse,chorus,bridge,solo,chorus,outro"
"""

import argparse
import sys
from datetime import datetime

GENRE_INFO = {
    "classic-rock": {"name": "Classic Rock 经典摇滚", "bpm_range": "100-130"},
    "hard-rock": {"name": "Hard Rock 硬摇滚", "bpm_range": "120-150"},
    "punk": {"name": "Punk Rock 朋克摇滚", "bpm_range": "160-200"},
    "alternative": {"name": "Alternative Rock 另类摇滚", "bpm_range": "80-140"},
    "metal": {"name": "Metal 金属", "bpm_range": "140-240"},
    "grunge": {"name": "Grunge 垃圾摇滚", "bpm_range": "80-120"},
    "indie": {"name": "Indie Rock 独立摇滚", "bpm_range": "100-140"},
    "prog": {"name": "Progressive Rock 前卫摇滚", "bpm_range": "可变"},
}

DEFAULT_STRUCTURE = "intro,verse,chorus,verse,chorus,bridge,solo,chorus,outro"

SECTION_BAR_SUGGESTIONS = {
    "intro": 4,
    "verse": 8,
    "pre-chorus": 4,
    "chorus": 8,
    "bridge": 8,
    "solo": 8,
    "outro": 4,
}


def generate_template(title, key, bpm, genre, structure, voicing):
    genre_name = GENRE_INFO.get(genre, {}).get("name", genre.replace("-", " ").title())
    sections = [s.strip() for s in structure.split(",")]

    lines = []
    lines.append(f"# 🎸 {title} — 编曲方案")
    lines.append("")
    lines.append(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")
    lines.append("## 📋 基本信息")
    lines.append("")
    lines.append(f"| 项目 | 值 |")
    lines.append(f"|------|-----|")
    lines.append(f"| 风格 | {genre_name} |")
    lines.append(f"| 调性 | {key} |")
    lines.append(f"| BPM  | {bpm} |")
    lines.append(f"| 拍号 | 4/4 |")
    lines.append("")
    lines.append("## 📐 曲式结构")
    lines.append("")
    lines.append(f"**总段落**: {' → '.join(s.upper() for s in sections)}")
    lines.append("")
    lines.append("| 段落 | 小节数 | 织体描述 | 动态级别 |")
    lines.append("|------|--------|----------|----------|")
    
    dynamics = ["弱", "中", "强", "最强"]
    for i, section in enumerate(sections):
        bars = SECTION_BAR_SUGGESTIONS.get(section, 8)
        dyn_idx = min(i, len(dynamics) - 1)
        if section in ("chorus", "solo"):
            dyn = "强"
        elif section in ("intro", "outro"):
            dyn = "弱"
        elif section == "bridge":
            dyn = "中"
        else:
            dyn = dynamics[dyn_idx % len(dynamics)]
        lines.append(f"| {section.capitalize()} | {bars} 小节 | [待填写] | {dyn} |")
    
    lines.append("")
    lines.append("## 🥁 鼓组编配")
    lines.append("")
    lines.append(f"### {sections[0].capitalize()} 段落")
    lines.append("- Kick: [待填写]")
    lines.append("- Snare: [待填写]")
    lines.append("- Hi-Hat/Cymbal: [待填写]")
    lines.append("- 特殊 fill: [待填写]")
    lines.append("")
    lines.append("### Chorus 段落")
    lines.append("- Kick: [待填写]")
    lines.append("- Snare: [待填写]")
    lines.append("- Hi-Hat/Cymbal: [待填写]")
    lines.append("- 特殊 fill: [待填写]")
    lines.append("")
    lines.append("## 🎸 吉他编配")
    lines.append("")
    lines.append("### 节奏吉他")
    lines.append(f"- 调弦: Standard{' / Drop D' if voicing == 'heavy' else ''}")
    lines.append(f"- 音色: {voicing}")
    lines.append("- Verse 编配: [待填写]")
    lines.append("- Chorus 编配: [待填写]")
    lines.append("")
    lines.append("### 主音吉他")
    lines.append("- 音色: [待填写]")
    lines.append("- Riff/licks 设计: [待填写]")
    lines.append("- Solo 段: [待填写]")
    lines.append("")
    lines.append("## 🎸 贝斯线")
    lines.append("")
    lines.append("- 主要节奏型: [待填写]")
    lines.append("- 与底鼓配合: [待填写]")
    lines.append("- 过门/变化: [待填写]")
    lines.append("")
    lines.append("## 🎤 人声")
    lines.append("")
    lines.append("- 主唱音域: [待填写]")
    lines.append("- Verse 旋律特点: [待填写]")
    lines.append("- Chorus 旋律特点: [待填写]")
    lines.append("- 伴唱安排: [待填写]")
    lines.append("")
    lines.append("## 🔄 关键过渡点")
    lines.append("")
    lines.append("| 过渡 | 手法 |")
    lines.append("|------|------|")
    
    for i in range(len(sections) - 1):
        lines.append(f"| {sections[i].capitalize()} → {sections[i+1].capitalize()} | [待填写] |")
    
    lines.append("")
    lines.append("## 💡 制作建议")
    lines.append("")
    lines.append("- 参考曲目: [待填写]")
    lines.append("- 音色建议: [待填写]")
    lines.append("- 录音建议: [待填写]")
    lines.append("- 混音注意事项: [待填写]")
    lines.append("")
    lines.append("---")
    lines.append(f"*由 Rock Arrangement Skill 生成*")
    
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="生成摇滚乐编曲方案模板")
    parser.add_argument("--title", default="未命名", help="歌曲标题")
    parser.add_argument("--key", default="E", help="调性 (e.g. E, A, D, G, C)")
    parser.add_argument("--bpm", type=int, default=120, help="速度 BPM")
    parser.add_argument("--genre", default="classic-rock", 
                        choices=list(GENRE_INFO.keys()),
                        help="摇滚风格")
    parser.add_argument("--structure", default=DEFAULT_STRUCTURE,
                        help="曲式结构，逗号分隔 (默认: intro,verse,chorus,verse,chorus,bridge,solo,chorus,outro)")
    parser.add_argument("--voicing", default="standard",
                        choices=["standard", "heavy", "clean"],
                        help="吉他音色倾向")
    parser.add_argument("--output", "-o", help="输出文件路径（默认输出到终端）")
    
    args = parser.parse_args()
    
    if args.bpm < 40 or args.bpm > 300:
        print("[ERROR] BPM 应在 40-300 之间", file=sys.stderr)
        sys.exit(1)
    
    template = generate_template(
        title=args.title,
        key=args.key.upper(),
        bpm=args.bpm,
        genre=args.genre,
        structure=args.structure,
        voicing=args.voicing,
    )
    
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(template)
        print(f"[OK] 模板已保存到: {args.output}")
    else:
        print(template)


if __name__ == "__main__":
    main()
