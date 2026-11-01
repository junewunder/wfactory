// The passes shape: passes over one intermediate representation, ending in emitted code.
//
// A skeleton to copy into a factory once and then own (docs/pipelines/README.md).
// Runs as it is: rustc --edition 2021 passes.rs && ./passes <input> <hints> <out dir>
//   <input>   the source to translate (fetched, not in git): one instruction per line
//   <hints>   the committed per-input annotations a pass reads: "<source line> <note>",
//             lines counted from 1
//   <out dir> emitted code, gitignored, never edited by hand

use std::collections::HashMap;
use std::{env, fs, path::Path};

/// The IR every pass reads and rewrites.
#[derive(Debug)]
enum Op {
    Push(i64),
    Add,
    Print,
    Nop,
}

/// Each op keeps the source line it came from (counted from 1), so hints
/// name source lines and stay right whatever order the passes run in.
struct Ir {
    ops: Vec<(usize, Op)>,
}

/// Facts a pass can't work out from the input, written down per input and
/// committed (addresses found by running the program, a symbol map). A fix to the
/// output is a fix to a pass, or a line here.
struct Hints(HashMap<usize, String>);

/// The one layer of polymorphism: the pass. One implementation per pass, no
/// deeper; the pass list is data. (The other place it can sit: one semantics
/// written once over a trait and read several ways: run it, build IR
/// from it, analyze it.)
trait Pass {
    fn name(&self) -> &'static str;
    fn run(&self, ir: &mut Ir, hints: &Hints);
}

struct DropDead;
impl Pass for DropDead {
    fn name(&self) -> &'static str {
        "drop-dead"
    }
    fn run(&self, ir: &mut Ir, hints: &Hints) {
        for (line, op) in ir.ops.iter_mut() {
            if hints.0.get(line).map(String::as_str) == Some("dead") {
                *op = Op::Nop;
            }
        }
        ir.ops.retain(|(_, op)| !matches!(op, Op::Nop));
    }
}

struct FoldConstants;
impl Pass for FoldConstants {
    fn name(&self) -> &'static str {
        "fold-constants"
    }
    fn run(&self, ir: &mut Ir, _: &Hints) {
        let mut out: Vec<(usize, Op)> = Vec::new();
        for (line, op) in ir.ops.drain(..) {
            match (op, out.as_slice()) {
                (Op::Add, [.., (first, Op::Push(a)), (_, Op::Push(b))]) => {
                    let (first, s) = (*first, a + b);
                    out.truncate(out.len() - 2);
                    out.push((first, Op::Push(s)));
                }
                (op, _) => out.push((line, op)),
            }
        }
        ir.ops = out;
    }
}

fn lower(src: &str) -> Ir {
    let ops = src
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
        .map(|(i, l)| {
            let op = match l.split_whitespace().collect::<Vec<_>>()[..] {
                ["push", n] => Op::Push(n.parse().expect("push takes a number")),
                ["add"] => Op::Add,
                ["print"] => Op::Print,
                _ => panic!("line {}: unknown instruction: {l}", i + 1),
            };
            (i + 1, op)
        })
        .collect();
    Ir { ops }
}

fn emit(ir: &Ir) -> String {
    let mut s = String::from("fn main() {\n    let mut st: Vec<i64> = Vec::new();\n");
    for (_, op) in &ir.ops {
        s += &match op {
            Op::Push(n) => format!("    st.push({n});\n"),
            Op::Add => "    let b = st.pop().unwrap(); let a = st.pop().unwrap(); st.push(a + b);\n".into(),
            Op::Print => "    println!(\"{}\", st.last().unwrap());\n".into(),
            Op::Nop => String::new(),
        };
    }
    s + "}\n"
}

fn main() {
    let a: Vec<String> = env::args().collect();
    let src = fs::read_to_string(&a[1]).expect("read the input");
    let hints = Hints(
        fs::read_to_string(&a[2])
            .expect("read the hints file (an empty one if there are none)")
            .lines()
            .filter_map(|l| l.split_once(' '))
            .map(|(n, v)| (n.parse().expect("a hint starts with a line number"), v.to_string()))
            .collect(),
    );
    let passes: Vec<Box<dyn Pass>> = vec![Box::new(DropDead), Box::new(FoldConstants)];
    let mut ir = lower(&src);
    for p in &passes {
        p.run(&mut ir, &hints);
        eprintln!("{}: {} ops", p.name(), ir.ops.len());
    }
    let out = Path::new(&a[3]);
    fs::create_dir_all(out).expect("make the out dir");
    fs::write(out.join("main.rs"), emit(&ir)).expect("write main.rs");
}
