/*jshint globalstrict:true, eqeqeq:true, curly:true, latedef:true, newcap:true,
  undef:true, trailing:true */
/*global require:false, console:false, print:false, tkn:false, Narcissus:false */
"use strict"; "use restrict";

var Ref = Ref || require("ref.js") || Ref;
var Shaper = Shaper || require("shaper.js") || Shaper;
var log = (typeof console !== "undefined") && console.log || print;

// converts functions containing yield/yield() to generators.
Shaper("yielder", function(root) {
    var allsyms = Object.create(null);
    var registersym = function(sym) {
        // add '$' to protect against built in object methods like
        // hasOwnProperty, etc.
        allsyms[sym+'$'] = true;
    };
    var gensym = (function(){
        var i = 0;
        return function(base) {
            var sym, first=true;
            base = base || 'tmp';
            do {
                // generate a new sym name, until it's actually unique...
                sym = '$'+base;
                if (first) {
                    first = false;
                } else {
                    sym += '$'+(i++);
                }
            } while ((sym+'$') in allsyms);
            registersym(sym);
            return sym;
        };
    })();
    var $Generator, $stop, $arguments, $pc, $ex, $val;

    function funcBodyStart(body, start_src) {
        start_src = start_src || '{';
        body.children = [];
        body.srcs = [start_src];
    }
    function funcBodyAdd(body, stmt, src) {
        if (Array.isArray(stmt)) {
            for (var i=0; i<stmt.length; i++) {
                funcBodyAdd(body, stmt[i], (i===(stmt.length-1))?src:'');
            }
        } else {
            body.children.push(stmt);
            body.srcs.push(src);
        }
    }
    function funcBodyAddComment(body, comment) {
        body.srcs[body.srcs.length-1] += comment;
    }
    function funcBodyFinish(body, close_src) {
        close_src = close_src || '}';
        body.srcs[body.srcs.length-1] += close_src;
    }

    var splitTokens = function(src, token) {
        var t = new Narcissus.lexer.Tokenizer(src);
        var i, tt, r=[], start=0;
        for (i=1; i<arguments.length; i++) {
            tt = t.mustMatch(arguments[i]);
            if (arguments[i]===tkn.END) { continue; }
            r.push(src.substring(start, tt.start));
            start = tt.end;
        }
        r.push(src.substring(start));
        return r;
    };
    var removeTokens = function(src, tokens) {
        return splitTokens.apply(this, arguments).join('');
    };
    var removeAllTokens = function(root) {
        var r = [];
        Shaper.traverse(root, {
            pre: function(node, ref) {
                if (node.leadingComment) {
                    r.push(node.leadingComment);
                }
                // grab newlines from srcs array; they might be slightly
                // misplaced (sigh)
                r.push(node.srcs.join('').replace(/\S/g,''));
            },
            post: function(node, ref) {
                if (node.trailingComment) {
                    r.push(node.trailingComment);
                }
            }
        });
        return r.join('');
    };
    var fixupJumps = function(fixups, labelEnd, this_target) {
        // fixup all break statements targetting this.
        for (var i=fixups.length-1; i>=0; i--) {
            var bf = fixups[i];
            if (arguments.length===2 || bf.target === this_target) {
                fixups.splice(i, 1);
                bf.ref.set(Shaper.parse(String(labelEnd)));
            }
        }
    };

    function YieldVisitor() {
        this.stack = [null];
        this.tryStack = [];
        this.breakFixup = [];
        this.continueFixup = [];
        this.newInternalCont();
        this.opt = [];
    }
    YieldVisitor.prototype = {
        top: function() { return this.stack[this.stack.length-1]; },
        add: function(child, src) {
            var top = this.top();
            funcBodyAdd(top.body, child, src);
        },
        addComment: function(comment) {
            var top = this.top();
            funcBodyAddComment(top.body, comment);
        },
        branchStmt: function(val) {
            if (typeof val === 'number') {
                val = String(val);
            }
            if (typeof val === 'string') {
                val = Shaper.parse(val);
            }
            // need to wrap the 'continue' in a throwaway while loop in order
            // to get it past the parser.
            var branchStmt = Shaper.replace('while(true){'+$pc+'=$;continue;}',
                                            val).body;
            branchStmt.children[1].expression.yielderSkip = true;
            return { stmt: branchStmt,
                     ref: new Ref(branchStmt.children[0].expression,
                                  'children', 1) };
        },
        optBranch: function(from, branchStmt) {
            this.opt.push({from: from,
                           to_ref:  branchStmt.ref,
                           cont:  branchStmt.stmt.children[1]});
        },
        addBranch: function(where) {
            if (!this.canFallThrough) {
                log("// Adding unreachable return");
            }
            var branchStmt = this.branchStmt(where);
            this.add(branchStmt.stmt.children, '');
            this.canFallThrough = false;
            this.optBranch(this.stack.length-1, branchStmt);
            return branchStmt;
        },
        close: function() {
            var top = this.top();
            if (!top) {
                this.stack.pop();
            } else {
                if (this.canFallThrough) {
                    this.add(Shaper.parse('throw '+$stop+';'), '');
                }
                funcBodyFinish(top.body);
            }
        },
        optimizeBranches: function() {
            this.opt.forEach(function(o) {
                var from = o.from;
                var to = o.to_ref.get();
                if (to.type!==tkn.NUMBER) { return; }
                to = to.value;
                if ((from+1) !== to) { return; }
                // remove the continue statement!
                o.cont.expression = null;
                o.cont.srcs = ['/*fall through*/'];
            });
        },

        newInternalCont: function() {
            this.close();

            var frame = Shaper.parse('switch(_){case '+this.stack.length+':{}}'
                                    ).cases[0];

            var new_top = { 'case': frame, body: frame.statements,
                            catcher:false };

            // find active try block
            var tb = null;
            for (var i=this.tryStack.length-1; i>=0; i--) {
                if (!this.tryStack[i].inCatch) {
                    tb = this.tryStack[i];
                    break;
                }
            }
            if (tb) {
                var v = tb.varName;
                var tryBlock = Shaper.parse('try { $ } catch ('+v+') { }');
                funcBodyStart(new_top.body);
                funcBodyAdd(new_top.body, tryBlock, '');
                funcBodyFinish(new_top.body);
                new_top.body = tryBlock.tryBlock;

                // fill out catch block
                var c = tryBlock.catchClauses[0].block, s;
                funcBodyStart(c);

                // if exception caught, branch to catch or finally block
                s = Shaper.parse($ex+'={ex:'+v+'};');
                funcBodyAdd(c, s, '');
                s = this.branchStmt(-1);
                funcBodyAdd(c, s.stmt.children, '');
                this.optBranch(this.stack.length, s);
                // record fixup needed for catch block.
                tb.catchFixups.push(s);
                funcBodyFinish(c);
            }
            funcBodyStart(new_top.body);

            this.stack.push(new_top);
            this.canFallThrough = true;
        },
        newExternalCont: function(yieldVarName) {
            this.newInternalCont();
            this.add(Shaper.parse('if ('+$ex+') {throw '+$ex+'.ex;}'),
                     '');
            this.add(Shaper.parse(yieldVarName+'='+$val+';'), '');
        },

        visit: function(child, src) {
            this.canFallThrough = true;
            if (child.type in this) {
                return this[child.type].call(this, child, src);
            }
            console.assert(!child.isLoop);
            var wrapper = { node: child };
            var ref = new Ref(wrapper, 'node');
            ref.set(Shaper.traverse(child, this, ref));
            this.add(wrapper.node, src);
        },

        visitBlock: function(children, srcs) {
            var i;
            console.assert(children.length === srcs.length);
            for (i=0; i<children.length; i++) {
                this.visit(children[i], srcs[i]);
            }
        },

        // rewrite arguments, catch expressions, var nodes, etc.
        pre: function(node, ref) {
            if (node.type === tkn.FUNCTION) {
                // skip nested functions.
                return "break";
            }
            if (node.type === tkn.VAR) {
                node.srcs[0] = removeTokens(node.srcs[0], tkn.VAR);
                node.type = tkn.COMMA;
            }
            if ((node.type === tkn.SEMICOLON &&
                 (node.expression.type === tkn.BREAK ||
                  node.expression.type === tkn.CONTINUE)) ||
                node.type === tkn.BREAK ||
                node.type === tkn.CONTINUE) {
                var leading='', trailing='';
                if (node.type === tkn.SEMICOLON) {
                    // eliminate upper SEMICOLON node; replace with BLOCK
                    leading = (node.leadingComment||'') +
                        node.srcs[0];
                    trailing= (node.trailingComment||'') +
                        removeTokens(node.srcs[1], tkn.SEMICOLON, tkn.END);
                    node = node.expression;
                }
                if (node.yielderSkip) {
                    // this is part of a generated branch sequence.
                    return "break";
                }
                var r = this.branchStmt(-1);
                var fixup = (node.type===tkn.BREAK) ?
                    this.breakFixup : this.continueFixup;
                fixup.push({ref:r.ref, target:node.target});
                // tweak comments.
                r.stmt.leadingComment = leading + (node.leadingComment||'');
                r.stmt.trailingComment = trailing + (node.trailingComment||'');

                if (node.label) {
                    var extra = removeTokens(node.srcs[0], node.type,
                                             tkn.IDENTIFIER, tkn.END);
                    r.stmt.trailingComment += extra;
                }
                this.canFallThrough = false;
                return ref.set(r.stmt);
            }
            if (node.type === tkn.RETURN) {
                this.canFallThrough = false;
                return ref.set(Shaper.parse('throw '+$stop));
            }
            if (node.type === tkn.THROW) {
                this.canFallThrough = false;
                // no other modification needed
                return;
            }
            if (node.type === tkn.YIELD) {
                var value;
                if (node.value) {
                    value = Shaper.traverse(node.value, this,
                                            new Ref(node, 'value'));
                } else {
                    value = Shaper.parse("void(0)");// 'undefined'
                }
                this.add(Shaper.parse($pc+'='+this.stack.length+';'));
                // need to wrap 'return' in a throwaway function in order
                // to get it past the parser.
                var rval = Shaper.parse('function _(){return $;}').
                    body.children[0];
                this.add(Shaper.replace(rval, value), '');
                this.canFallThrough=false;
                this.newExternalCont(node.yieldVarName);
                return ref.set(Shaper.parse(node.yieldVarName));
            }
        }
    };
    YieldVisitor.prototype[tkn.BLOCK] = function(node, src) {
        var leading = node.leadingComment || '';
        leading += removeTokens(node.srcs[0], tkn.LEFT_CURLY);
        var trailing = node.trailingComment || '';
        trailing += src;

        if (node.children.length===0) {
            // make a semicolon node, just to have a place to put the
            // comments.
            var semi = Shaper.parse(';');
            semi.leadingComment = removeTokens(leading, tkn.RIGHT_CURLY);
            this.add(semi, trailing);
            return;
        }

        // XXX could wrap '$block = Object.create($block);' and
        //     '$block = Object.getPrototypeOf($block);' around contents
        //     here to implement block scoping.

        // adjust comments.
        var new_srcs = node.srcs.slice(1);
        new_srcs[new_srcs.length-1] =
            removeTokens(new_srcs[new_srcs.length-1], tkn.RIGHT_CURLY) +
            trailing;
        node.children[0].leadingComment = leading +
            (node.children[0].leadingComment || '');
        // visit the statements, in turn.
        this.visitBlock(node.children, new_srcs);
    };
    YieldVisitor.prototype[tkn.LABEL] = function(node, src) {
        // transfer comments/whitespace around label
        var leading = (node.leadingComment || '') +
            (node._label.trailingComment || '');
        node.statement.leadingComment = leading +
            (node.statement.leadingComment || '');

        var this_target = node.statement;
        if (this_target.type===tkn.SEMICOLON) {
            this_target = this_target.expression;
        }
        this.visit(node.statement, src); // may mutate node.statement

        var labelEnd = this.stack.length;
        if (this.canFallThrough) {
            this.addBranch(labelEnd);
        }
        this.newInternalCont();
        fixupJumps(this.breakFixup, labelEnd, this_target);
    };
    YieldVisitor.prototype[tkn.DO] = function(child, src) {
        child.condition = Shaper.traverse(child.condition, this,
                                          new Ref(child, 'condition'));
        var loopStart = this.stack.length;
        if (child.leadingComment) {
            this.addComment(child.leadingComment);
        }
        this.addBranch(loopStart);

        this.newInternalCont();
        this.visit(child.body, '');
        var loopContinue = this.stack.length;
        if (this.canFallThrough) {
            this.addBranch(loopContinue);
        }
        this.newInternalCont();

        // bottom of loop: check the condition.
        var loopCheck = Shaper.parse("if ($) $");
        loopCheck.condition = child.condition;
        loopCheck.thenPart = this.branchStmt(loopStart).stmt;
        // transfer comments.
        loopCheck.srcs[0] = child.srcs[1].replace(/^while/, 'if');
        loopCheck.thenPart.trailingComment =
            removeTokens(src, tkn.RIGHT_PAREN, tkn.SEMICOLON, tkn.END);
        this.add(loopCheck, '');
        this.addBranch(this.stack.length);
        if (child.trailingComment) {
            this.addComment(child.trailingComment);
        }

        fixupJumps(this.breakFixup, this.stack.length, child);
        fixupJumps(this.continueFixup, loopContinue, child);
        this.newInternalCont();
    };
    YieldVisitor.prototype[tkn.WHILE] = function(child, src) {
        console.assert(src==='');
        child.condition = Shaper.traverse(child.condition, this,
                                          new Ref(child, 'condition'));
        var loopStart = this.stack.length;
        this.addBranch(loopStart);
        this.newInternalCont();

        // top of loop: check the condition.
        var loopCheck = Shaper.parse("if (!($)) $");
        loopCheck.condition.children[0].children[0] = child.condition;
        var branchFixup = this.branchStmt(-1);
        loopCheck.thenPart = branchFixup.stmt;
        // transfer comments.
        Shaper.cloneComments(loopCheck, child);
        loopCheck.srcs[0] = child.srcs[0].replace(/^while/, 'if');
        this.add(loopCheck, '');

        this.visit(child.body, '');
        if (this.canFallThrough) {
            this.addBranch(loopStart);
        }

        // fixup loop check
        fixupJumps([branchFixup], this.stack.length);
        fixupJumps(this.breakFixup, this.stack.length, child);
        fixupJumps(this.continueFixup, loopStart, child);
        this.newInternalCont();
    };
    YieldVisitor.prototype[tkn.FOR_IN] = function(node, src) {
        console.assert(false, "should have been removed in previous pass");
    };
    YieldVisitor.prototype[tkn.FOR] = function(child, src) {
        var setup;

        // fixup comments
        var extraComment = child.leadingComment || '';
        extraComment += child.srcs.slice(
            0, 1+(child.setup?1:0)+(child.condition?1:0)+(child.update?1:0)).
            join('');
        extraComment = removeTokens(extraComment, tkn.FOR, tkn.LEFT_PAREN);
        var split = splitTokens(extraComment, tkn.SEMICOLON,
                                tkn.SEMICOLON, tkn.RIGHT_PAREN,
                                tkn.END);
        this.addComment(split[0]);

        // if there is setup, emit it first.
        if (child.setup) {
            child.setup = Shaper.traverse(child.setup, this,
                                          new Ref(child, 'setup'));
            this.add(Shaper.replace('$;', child.setup), '');
        }
        this.addComment(split[1]);

        // now proceed like a while loop
        child.condition = Shaper.traverse(child.condition, this,
                                          new Ref(child, 'condition'));
        var loopStart = this.stack.length;
        this.addBranch(loopStart);
        this.newInternalCont();

        // top of loop: check the condition.
        var loopCheck = Shaper.parse("if (!($)) $");
        loopCheck.condition.children[0].children[0] = child.condition ||
            Shaper.parse('true');
        var branchFixup = this.branchStmt(-1);
        loopCheck.thenPart = branchFixup.stmt;
        loopCheck.thenPart.trailingComment = split[2] + split[3];
        if (child.condition) {
            this.add(loopCheck, '');
        } else {
            this.addComment(loopCheck.thenPart.trailingComment);
        }

        // loop body
        this.visit(child.body, src);

        // loop update
        if (this.canFallThrough) {
            if (child.update) {
                child.update = Shaper.traverse(child.update, this,
                                               new Ref(child, 'update'));
                var update = Shaper.replace('$;', child.update);
                this.add(update, '');
            }
            this.addBranch(loopStart);
        } else if (child.update) {
            // transfer comments from child.update
            this.addComment(removeAllTokens(child.update));
        }

        // fixup loop check
        fixupJumps([branchFixup],this.stack.length);
        fixupJumps(this.breakFixup, this.stack.length, child);
        fixupJumps(this.continueFixup, loopStart, child);
        if (child.formerly) { // handle converted for-in loops
            fixupJumps(this.breakFixup, this.stack.length, child.formerly);
            fixupJumps(this.continueFixup, loopStart, child.formerly);
        }
        this.newInternalCont();
    };
    YieldVisitor.prototype[tkn.IF] = function(child, src) {
        child.condition = Shaper.traverse(child.condition, this,
                                          new Ref(child, 'condition'));
        var ifLoc = this.stack.length - 1, b;
        this.add(child, '');
        this.canFallThrough = false; // both sides of IF will get returns

        var thenPart = this.stack.length;
        this.newInternalCont();
        this.visit(child.thenPart, child.elsePart ? '' : src);
        var thenPlace = this.canFallThrough ?
            this.addBranch(this.stack.length) : null /*optimization*/;
        // replace original thenPart with branch to continuation
        b = this.branchStmt(thenPart);
        child.thenPart = b.stmt;
        this.optBranch(ifLoc, b);

        if (child.elsePart) {
            var elsePart = this.stack.length;
            this.newInternalCont();
            this.visit(child.elsePart, src);
            if (this.canFallThrough) {
                this.addBranch(this.stack.length);
            }
            // replace original elsePart with branch to continuation
            b = this.branchStmt(elsePart);
            child.elsePart = b.stmt;
            if (child.srcs[2].length===4) {
                child.srcs[2] += ' '; // ensure token separation
            }
            this.optBranch(ifLoc, b);
            // fixup then part
            if (thenPlace) {
                fixupJumps([thenPlace], this.stack.length);
            }
        } else {
            console.assert(child.srcs.length===3);
            child.elsePart = this.branchStmt(this.stack.length).stmt;
            child.srcs.splice(2, 0, ' else ');
        }
        this.newInternalCont();
    };
    YieldVisitor.prototype[tkn.SWITCH] = function(node, src) {
        var i, r;
        var s = Shaper.parse(node.switchVarName+' = $;');
        s = Shaper.replace(s, node.discriminant);
        if (node.leadingComment) { this.addComment(node.leadingComment); }
        this.addComment(removeTokens(node.srcs[0],
                                     tkn.SWITCH, tkn.LEFT_PAREN, tkn.END));
        this.add(s);
        r = this.addBranch(-1);
        this.addComment(removeTokens(node.srcs[1],
                                     tkn.RIGHT_PAREN, tkn.LEFT_CURLY, tkn.END));
        this.newInternalCont();

        var defaultLabel=null;
        var nextTest = [r], nextBody = [];

        for (i=0; i<node.cases.length; i++) {
            var c = node.cases[i];
            var csrc = node.srcs[i+2];
            if (i===node.cases.length-1) {
                csrc = removeTokens(csrc, tkn.RIGHT_CURLY, tkn.END) + src;
            }
            if (c.leadingComment) { this.addComment(c.leadingComment); }
            if (c.type===tkn.DEFAULT) {
                defaultLabel = this.stack.length-1;
                this.addComment(removeTokens(c.srcs[0],
                                             tkn.DEFAULT, tkn.COLON, tkn.END));
            } else {
                // new case test
                fixupJumps(nextTest, this.stack.length-1);
                r = this.branchStmt(-1);
                nextBody.push(r);
                s = Shaper.parse('if ('+node.switchVarName+'===($)) $');
                s = Shaper.replace(s, c.caseLabel, r.stmt);
                this.addComment(removeTokens(c.srcs[0], tkn.CASE, tkn.END));
                this.add(s, removeTokens(c.srcs[1], tkn.COLON, tkn.END));

                // branch to next case test
                nextTest.push(this.addBranch(-1));

                this.newInternalCont();
            }
            fixupJumps(nextBody, this.stack.length-1);
            this.addComment(c.srcs[c.srcs.length-1]);
            // c.statements is a block w/o braces.  fixup before visiting.
            console.assert(c.statements.type===tkn.BLOCK);
            console.assert(c.statements.srcs.join('').indexOf('{')===-1);
            c.statements.srcs[0] = '{' + c.statements.srcs[0];
            c.statements.srcs[c.statements.srcs.length-1] += '}';
            this.visit(c.statements, csrc);

            if (this.canFallThrough) {
                // branch to next case body
                nextBody.push(this.addBranch(-1));
            }
            if (c.trailingComment) { this.addComment(c.trailingComment); }
            this.newInternalCont();
        }
        // default case.
        if (defaultLabel!==null) {
            fixupJumps(nextTest, defaultLabel);
        } else {
            fixupJumps(nextTest, this.stack.length-1);
        }
        // fall through; break
        fixupJumps(this.breakFixup, this.stack.length-1, node);
        fixupJumps(nextBody, this.stack.length-1);
        if (node.trailingComment) { this.addComment(node.trailingComment); }
    };
    YieldVisitor.prototype[tkn.TRY] = function(node, src) {
        var c,i,j,s;
        if (node.leadingComment) {
            this.addComment(node.leadingComment);
        }
        this.addBranch(this.stack.length);

        var hasFinally = !!node.finallyBlock;
        var finallyFixups = [];
        var addFallThroughBranch;
        if (hasFinally) {
            this.tryStack.push({inCatch:false, isFinally:true,
                                varName: node.finallyVarName,
                                catchFixups: finallyFixups});
            addFallThroughBranch = function() {
                this.add(Shaper.parse($ex+'={fall:true};'));
                finallyFixups.push(this.addBranch(-1));
            }.bind(this);
        } else {
            addFallThroughBranch = function() {
                // record fixup
                finallyFixups.push(this.addBranch(-1));
            }.bind(this);
        }
        for (i=node.catchClauses.length-1; i>=0; i--) {
            c = node.catchClauses[i];
            this.tryStack.push({varName:c.yieldVarName, inCatch:false,
                                catchFixups: [], finallyFixups: finallyFixups});
        }

        this.newInternalCont();
        this.visit(node.tryBlock, '');
        if (this.canFallThrough) {
            addFallThroughBranch();
        }

        // catch blocks
        for (i=0; i<node.catchClauses.length; i++) {
            var catchStart = this.stack.length;
            c = this.tryStack[this.tryStack.length-1];
            c.inCatch = true;
            fixupJumps(c.catchFixups, catchStart);

            this.newInternalCont();
            // assign thrown exception to (renamed) variable in catch
            var cc = node.catchClauses[i];
            s = Shaper.parse(cc.yieldVarName+' = '+$ex+'.ex;');
            Shaper.cloneComments(s, cc._name);
            var extra = (cc.leadingComment||'') +
                removeTokens(cc.srcs[0], tkn.CATCH, tkn.LEFT_PAREN);
            s.leadingComment = extra + (s.leadingComment||'');
            this.add(s, '');

            // bail if this is a stopiteration exception!
            s = Shaper.parse('if ('+cc.yieldVarName+'==='+$stop+') '+
                             '{ throw '+cc.yieldVarName+'; }');
            this.add(s, '');

            this.visit(cc.block, '');

            // XXX if we leave this block via exception it would be nice
            //     to release the reference to the caught exception.

            if (this.canFallThrough) {
                // release the reference to the caught exception
                this.add(Shaper.parse(cc.yieldVarName+'=null;'), '');
                addFallThroughBranch();
            }
            this.tryStack.pop();
        }

        // after try / finally
        var finallyLabel = this.stack.length;
        fixupJumps(finallyFixups, finallyLabel);
        if (hasFinally) {
            c = this.tryStack.pop();
            this.newInternalCont();
            this.add(Shaper.parse(node.finallyVarName+' = '+$ex+';'), '');

            this.visit(node.finallyBlock, '');

            if (this.canFallThrough) {
                s = Shaper.parse('if (!'+node.finallyVarName+'.fall) '+
                                 'throw '+node.finallyVarName+'.ex;');
                this.add(s, '');
                this.addBranch(this.stack.length); // fall through
            }
        }

        this.newInternalCont();
        if (node.trailingComment) {
            this.addComment(node.trailingComment);
        }
        this.addComment(src);
    };

    function rewriteGeneratorFunc(node, props, ref) {
        var stmts = [];
        var i;
        // export the Generator and StopIteration
        stmts.push(Shaper.parse('var '+$Generator+' = require("generator.js");'));
        stmts.push(Shaper.parse('var '+$pc+' = 0;'));
        if (props.vars.length > 0) {
            stmts.push(Shaper.parse("var "+props.vars.join(',')+";"));
        }
        if (props['arguments']) {
            stmts.push(Shaper.parse('var '+$arguments+' = arguments;'));
        }
        var yv = new YieldVisitor();
        console.assert(node.body.children.length > 0);
        // first and last node.body.srcs elements stay with outer function.
        var old_srcs = node.body.srcs;
        var inner_srcs = old_srcs.slice(1, old_srcs.length-1);
        inner_srcs.push('');

        // check first send.
        yv.add(Shaper.parse('if('+$ex+'||('+$val+'!==void(0))){'+
                            'throw new TypeError();'+
                            '}'), '');
        // translate function
        yv.visitBlock(node.body.children, inner_srcs);
        yv.close();
        yv.optimizeBranches();

        var s = Shaper.parse('_=function('+$stop+','+$ex+','+$val+'){'+
                             'while(true){'+
                             'switch('+$pc+'){'+
                             '}}}').children[1];
        var sw = s.body.children[0].body.children[0];
        sw.cases = yv.stack.map(function(c) { return c['case']; });
        sw.srcs[1]='){';
        yv.stack.forEach(function(e){ sw.srcs.push(''); });
        sw.srcs[sw.srcs.length-1]+='}';
        sw.cases.forEach(function(c) {
            var srcs = c.statements.srcs;
            srcs[0] = removeTokens(srcs[0],tkn.LEFT_CURLY);
            srcs[srcs.length-1] = removeTokens(srcs[srcs.length-1],
                                               tkn.RIGHT_CURLY);
        });

        // Note that we need to make a bogus function wrapper here or else
        // parse() will complain about the 'return outside of a function'
        var newBody = Shaper.replace(
            'function _(){return new '+$Generator+'($.bind(this));}',
            s).body.children[0];
        stmts.push(newBody);

        // hollow out old function and replace it with new function body
        funcBodyStart(node.body, old_srcs[0]);
        for (i=0; i<stmts.length; i++) {
            funcBodyAdd(node.body, stmts[i], '');
        }
        funcBodyFinish(node.body, old_srcs[old_srcs.length-1]);

        return node;
    }

    // rewrite generator expressions and array comprehensions
    root = Shaper.traverse(root, {
        generator: function(node) {
            var forLoop = node.tail.children[0];
            var guard = node.tail.guard || Shaper.parse('true');
            var s = Shaper.parse('(function(){'+
                                 'var '+forLoop.iterator.name+';'+
                                 '$})()');
            s = Shaper.replace(s, forLoop);
            var y = Shaper.parse('function _(){if ($) yield ($);}').
                body.children[0];
            forLoop.body = Shaper.replace(y, guard, node.expression);
            // _iterator is not a varDecl.
            forLoop._iterator = Shaper.parse(forLoop.iterator.name);
            delete forLoop.varDecl;
            // have to fix up forLoop's srcs array, weird
            var src = splitTokens(forLoop.srcs[0], tkn.FOR);
            var src0 = src[0]+'for ';
            if (forLoop.isEach) {
                src = splitTokens(src[1], tkn.IDENTIFIER/*each*/);
                src0 += src[0]+'each ';
            }
            src = removeTokens(src[1], tkn.LEFT_PAREN, tkn.IDENTIFIER);
            src0 += '(';
            forLoop.srcs.splice(0, 1, src0, src);
            forLoop.srcs.push('');
            return s;
        },
        post: function(node, ref) {
            var s;
            if (node.type === tkn.ARRAY_COMP) {
                s = Shaper.parse('(($).toArray())');
                s = Shaper.replace(s, this.generator(node));
                // have to remove trailing '[' from parent's src
                console.assert(ref.properties.length===2 &&
                               ref.properties[0]==='children');
                var n = +ref.properties[1];
                ref.base.srcs[n] = ref.base.srcs[n].replace(/\[(\s*)$/, '$1');
                return ref.set(s);
            }
            if (node.type === tkn.GENERATOR) {
                s = Shaper.parse('($)');
                s = Shaper.replace(s, this.generator(node));
                return ref.set(s);
            }
        }
    });

    // find functions containing 'yield' and take note of uses of
    // 'arguments' and 'catch' as well.  Register all symbols so that
    // gensym is guaranteed to be safe.
    var yieldfns = [];
    root = Shaper.traverse(root, {
        fns: [{fake:true,vars:[],caught:[]}],
        pre: function(node, ref) {
            var i;
            if (node.type === tkn.FUNCTION) {
                this.fns.push({node: node, ref: ref, vars: [], caught: [],
                               'yield': false, 'arguments': false,
                               'catch': false, 'finally': false});
                for (i=0; i<node.params.length; i++) {
                    registersym(node.params[i]);
                }
            }
            var fn = this.fns[this.fns.length-1];
            if (node.type === tkn.YIELD) {
                if (fn.fake) {
                    Shaper.error(node, "yield outside function");
                } else {
                    fn['yield'] = true;
                }
            }
            if (node.type === tkn.VAR) {
                for (i=0; i<node.children.length; i++) {
                    var child = node.children[i];
                    if (child.type===tkn.ASSIGN) {
                        child = child.children[0];
                    }
                    console.assert(child.type===tkn.IDENTIFIER);
                    fn.vars.push(child.value);
                    registersym(child.value);
                }
            }
            if (node.type === tkn.CATCH) {
                fn['catch'] = true;
                fn.caught.push(node.varName);
                registersym(node.varName);
            }
            if (node.type === tkn.TRY && node.finallyBlock) {
                fn['finally'] = true;
            }
            if (node.type === tkn.IDENTIFIER && node.value === 'arguments') {
                // a bit conservative:: you might have defined your own
                // variable named arguments, etc.  no worries.
                fn['arguments'] = true;
            }
            if (node.type === tkn.IDENTIFIER) {
                // again conservative: gets property names, too.
                registersym(node.value);
            }
        },
        post: function(node, ref) {
            var fn;
            if (node.type === tkn.FUNCTION) {
                fn = this.fns.pop();
                fn.node.yield_info = fn;
                if (fn['yield']) {
                    yieldfns.push(fn);
                }
            }
        }
    });

    // gensym
    $Generator = gensym('Generator');
    $stop = gensym('stop');
    $arguments = gensym('arguments');
    $pc = gensym('pc');
    $ex = gensym('ex');
    $val = gensym('val');

    // rewrite for-in loops
    root = Shaper.traverse(root, {
        post: function(node, ref) {
            if (node.type === tkn.FOR_IN) {
              // convert to use iterator
              var it = gensym('it'), e = gensym('e');
              var param=(node.isEach ? "false,true" : "true");
              var newFor = Shaper.replace('for(var '+it+'=Iterator($,'+param+');;){'+
                                          'try { $='+it+'.next(); } '+
                                          'catch ('+e+') { '+
                                          'if ('+e+'===StopIteration) break; '+
                                          'throw '+e+'; }'+
                                          '$}',
                                          node.object,
                                          node.varDecl || node._iterator,
                                          node.body);
              newFor.labels = node.labels;
              Shaper.cloneComments(newFor, node);
              newFor.srcs[0] = node.srcs[0];
              if (node.isEach) {
                  newFor.srcs[0] = 'for' +
                      removeTokens(node.srcs[0], tkn.FOR,
                                   tkn.IDENTIFIER/*each*/);
              }
              newFor.srcs[1] =
                  removeTokens(node.srcs[1], tkn.IN, tkn.END) +
                  newFor.srcs[1] +
                  removeTokens(node.srcs[2], tkn.RIGHT_PAREN, tkn.END);
              newFor.srcs[2] = node.srcs[3];
              newFor.formerly = node; // for matching up break/continue
              // looks better if we move the trailing comment from the old body
              // to the new body
              var trailing = node.body.trailingComment || '';
              delete node.body.trailingComment;
              newFor.body.trailingComment = trailing +
                  (newFor.body.trailingComment || '');
              return ref.set(newFor);
          }
        }
    });

    // rewrite 'function foo(...)' to 'var foo = function(...)'
    // DO THIS GLOBALLY (not just inside generators).
    // THIS ALTERS THE SEMANTICS OF THE LANGUAGE.
    // See https://bugs.webkit.org/show_bug.cgi?id=65546 and
    //     https://bugs.webkit.org/show_bug.cgi?id=27226
    // We need to hoist the scope of the function declaration to make
    // the generator work; the question is whether to attempt to
    // move the entire function declaration (as webkit does) or just
    // do the 'function foo' -> 'var foo = function' transformation
    // (as mozilla does) which postpones the definition of foo until
    // the assignment statement is executed.
    // Since the rest of the yielder code is basically making webkit
    // "more like JavaScript 1.7" (yield, generators, and iterators)
    // it makes sense to just do the 'function foo' -> 'var foo = function'
    // transformation to make this aspect of the semantics the same as
    // JavaScript 1.7 as well, rather than to jump through hoops to try
    // to preserve the arguably-broken-but-unfixable webkit semantics.
    // If we're going to make this change, we're going to make it globally,
    // so that we don't have one behavior inside generators and
    // a different one outside.
    root = Shaper.traverse(root, {
        func_stack: [{func:root, hoist:[]}],
        pre: function(node, ref) {
            if (node.type === tkn.FUNCTION) {
                this.func_stack.push({func: node, hoist:[]});
            }
        },
        post: function(node, ref) {
            var f,i,s;
            if (node.type === tkn.FUNCTION) {
                f = this.func_stack.pop();
                // hoist any of this function's children who need it.
                for (i=f.hoist.length-1; i>=0; i--) {
                    var sref = f.hoist[i];
                    s = sref.get();
                    // grab the 'src' which is about to be deleted by .remove()
                    // (this logic is copied from the Shaper.remove())
                    var index = Number(sref.properties[1]);
                    if (index !== sref.base[sref.properties[0]].length) {
                        index++;
                    }
                    var src = sref.base.srcs[index];
                    // remove the statement from its old location
                    Shaper.remove(sref);
                    // add it to the top of the function.
                    Shaper.insertBefore(new Ref(node.body, 'children', 0),
                                        s, src);
                }
                var parent = this.func_stack[this.func_stack.length-1];
                if (ref.base === root) {
                    /* leave top level decls alone */
                    return;
                }
                if (ref.base.type===tkn.SCRIPT ||
                    ref.base.type===tkn.BLOCK) {
                    // function statement (not a function expression)
                    // rewrite as 'var ... = function ...'
                    var name = node.name || gensym('f');
                    s = Shaper.replace(Shaper.parse('var '+name+' = $;'),
                                       node);
                    if (ref.base === parent.func.body) {
                        // for top-level function statements, mark them
                        // for hoisting to the top of the function.
                        parent.hoist.push(ref);
                    }
                    return ref.set(s);
                }
            }
        }
    });
    // rewrite catch variables and 'arguments'; assign temps to 'yield's
    root = Shaper.traverse(root, {
        func_stack: [{yield_info:{}}],
        varenv: {
            env: Object.create(null),
            push: function() { this.env = Object.create(this.env); },
            pop: function() { this.env = Object.getPrototypeOf(this.env); },
            remove: function(v) { this.env[v+'$'] = false; },
            put: function(v, nv) { this.env[v+'$'] = nv; },
            has: function(v) { return !!this.env[v+'$']; },
            get: function(v) { return this.env[v+'$']; }
        },
        current_func: function() {
            return this.func_stack[this.func_stack.length-1];
        },
        pre: function(node, ref) {
            if (node.type===tkn.FUNCTION) {
                this.func_stack.push(node);
                // remove mappings for 'var' and function parameters
                this.varenv.push();
                // var-bound variables
                var v = node.yield_info.vars, i;
                for (i=0; i<v.length; i++) {
                    this.varenv.remove(v[i]);
                }
                // function parameters
                v = node.params;
                for (i=0; i<v.length; i++) {
                    this.varenv.remove(v[i]);
                }
                // if this is a generator, add new name for 'arguments'
                if (node.yield_info['yield']) {
                    this.varenv.put('arguments', $arguments);
                } else {
                    this.varenv.remove('arguments');
                }
            }
            var yi = this.current_func().yield_info;
            if (node.type===tkn.DOT) {
                // only traverse 1st child; second is not an expression
                Shaper.traverse(node.children[0], this,
                                new Ref(node, 'children', 0));
                return "break";
            }
            if (node.type===tkn.PROPERTY_INIT) {
                // only traverse 2nd child; first is not an expression
                Shaper.traverse(node.children[1], this,
                                new Ref(node, 'children', 1));
                return "break";
            }
            if (node.type===tkn.IDENTIFIER) {
                if (this.varenv.has(node.value)) {
                    Shaper.renameIdentifier(node, this.varenv.get(node.value)); 
                }
            }
            if (node.type===tkn.CATCH) {
                this.varenv.push();
                if (yi['yield']) {
                    // catch inside a generator!
                    // add this to the environment
                    node.yieldVarName = gensym(node.varName);
                    this.varenv.put(node.varName, node.yieldVarName);
                    yi.vars.push(node.yieldVarName);
                } else if (this.varenv.has(node.varName)) {
                    // this catch shadows a previously-caught variable;
                    // remove it from the environment.
                    this.varenv.remove(node.varName);
                }
            }
            if (node.type===tkn.TRY && node.finallyBlock) {
                if (yi['yield']) {
                    node.finallyVarName = gensym('finally');
                    yi.vars.push(node.finallyVarName);
                }
            }
            if (node.type===tkn.YIELD) {
                node.yieldVarName = gensym('yield');
                yi.vars.push(node.yieldVarName);
            }
            if (node.type===tkn.SWITCH) {
                if (yi['yield']) {
                    node.switchVarName = gensym('switch');
                    yi.vars.push(node.switchVarName);
                }
            }
        },
        post: function(node, ref) {
            if (node.type===tkn.FUNCTION) {
                this.func_stack.pop();
            }
            if (node.type===tkn.FUNCTION || node.type===tkn.CATCH) {
                // pop caught variables off the scope.
                this.varenv.pop();
            }
        }
    });
    // rewrite generator functions
    for (var i=0; i<yieldfns.length; i++) {
        rewriteGeneratorFunc(yieldfns[i].node, yieldfns[i], yieldfns[i].ref);
    }
    return root;
});
