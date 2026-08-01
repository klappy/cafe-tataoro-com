
(function(){
  /* Theme wrappers carry transforms (scroll-trigger animations) which turn
     position:fixed descendants into container-fixed. Reparent all fixed
     elements to <body> so they pin to the real viewport. */
  try{
    var fixedEls=document.querySelectorAll('.lang-pill,.sticky-bar,.exit-veil');
    for(var fi=0;fi<fixedEls.length;fi++){document.body.appendChild(fixedEls[fi]);}
    var rte=document.querySelector('main .rte');
    if(rte){rte.removeAttribute('class');rte.id='cafe-root';}
  }catch(e){}

  /* ---- Language toggle ---- */
  var root=document.documentElement,
      pill=document.getElementById('langPill'),
      footBtn=document.getElementById('langFooter');
  function apply(lang){
    root.setAttribute('data-lang',lang);
    root.setAttribute('lang',lang);
    pill.textContent = lang==='en' ? 'ES' : 'EN';
    footBtn.textContent = lang==='en' ? 'Español' : 'English';
    var opts=document.querySelectorAll('option[data-en]');
    for(var i=0;i<opts.length;i++){
      opts[i].textContent = lang==='es' ? opts[i].getAttribute('data-es') : opts[i].getAttribute('data-en');
    }
    try{localStorage.setItem('cafe-lang',lang);}catch(e){}
  }
  function toggle(){apply(root.getAttribute('data-lang')==='en'?'es':'en');}
  pill.addEventListener('click',toggle);
  footBtn.addEventListener('click',toggle);
  var saved=null;
  try{saved=localStorage.getItem('cafe-lang');}catch(e){}
  apply(saved || ((navigator.language||'').toLowerCase().indexOf('es')===0 ? 'es' : 'en'));

  /* ---- Cart wiring ---- */
  var grind=document.getElementById('grind'),qty=document.getElementById('qty'),
      buyBtn=document.getElementById('buyBtn'),stickyBtn=document.getElementById('stickyBtn');
  var inbound=new URLSearchParams(location.search);
  try{
    if(inbound.get('utm_source')){sessionStorage.setItem('cafe-utm',inbound.toString());}
    else{var s=sessionStorage.getItem('cafe-utm');if(s){inbound=new URLSearchParams(s);}}
  }catch(e){}

  var WB='49618614714520',GRD='49618530697368';
  var qtyField=document.getElementById('qtyField'),notifyField=document.getElementById('notifyField'),
      notifyBtn=document.getElementById('notifyBtn'),notifyDone=document.getElementById('notifyDone'),
      notifyErr=document.getElementById('notifyErr'),notifyEmail=document.getElementById('notifyEmail');
  function sync(){
    var wb=grind.value===WB;
    qtyField.hidden=wb;notifyField.hidden=!wb;buyBtn.hidden=wb;notifyBtn.hidden=!wb;
    notifyDone.hidden=true;notifyErr.hidden=true;
    var v=wb?GRD:grind.value;
    buyBtn.href='https://tataoro.com/cart/add?id='+v+'&quantity='+qty.value+'&return_to=%2Fcart&'+cartParams('landing');
    stickyBtn.href='https://tataoro.com/cart/add?id='+GRD+'&quantity='+qty.value+'&return_to=%2Fcart&'+cartParams('sticky');
  }
  function cartParams(medium){
    var q=new URLSearchParams();
    q.set('utm_source',inbound.get('utm_source')||'cafe.tataoro.com');
    q.set('utm_medium',inbound.get('utm_medium')||medium);
    q.set('utm_campaign',inbound.get('utm_campaign')||'romance');
    q.set('utm_content',medium);
    return q.toString();
  }
  notifyBtn.addEventListener('click',function(){
    var email=(notifyEmail.value||'').trim();
    notifyDone.hidden=true;notifyErr.hidden=true;
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){notifyErr.hidden=false;notifyEmail.focus();return;}
    notifyBtn.disabled=true;
    fetch('https://cafe.tataoro.com/api/notify',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({email:email,intent:'whole-bean',
        lang:document.documentElement.getAttribute('data-lang')||'en',
        utm:inbound.toString()})})
      .then(function(r){
        if(!r.ok)throw 0;
        if(grind.value!==WB)return;
        notifyDone.hidden=false;notifyField.hidden=true;notifyBtn.hidden=true;
      })
      .catch(function(){if(grind.value!==WB)return;notifyErr.hidden=false;})
      .finally(function(){notifyBtn.disabled=false;});
  });
  grind.addEventListener('change',sync);qty.addEventListener('change',sync);sync();


  /* ---- Sticky bar + reveals ---- */
  var bar=document.getElementById('stickyBar'),hero=document.querySelector('.hero'),buySec=document.getElementById('buy');
  if('IntersectionObserver' in window){
    var heroSeen=true,buySeen=false;
    function update(){var show=!heroSeen&&!buySeen;bar.classList.toggle('show',show);bar.setAttribute('aria-hidden',String(!show));}
    new IntersectionObserver(function(e){heroSeen=e[0].isIntersecting;update();},{threshold:.2}).observe(hero);
    new IntersectionObserver(function(e){buySeen=e[0].isIntersecting;update();},{threshold:.2}).observe(buySec);
    var reveals=document.querySelectorAll('.reveal');
    var ro=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){en.target.classList.add('in');ro.unobserve(en.target);}});},{threshold:.15});
    reveals.forEach(function(el){ro.observe(el);});
  }

  /* ---- Exit survey: mouseleave on desktop, dwell fallback on mobile; once per session ---- */
  (function(){
    var veil=document.getElementById('exitVeil');
    if(!veil)return;
    var shown=false;
    try{shown=sessionStorage.getItem('cafe-exit-shown')==='1';}catch(e){}
    function openSurvey(){
      if(shown)return;shown=true;
      try{sessionStorage.setItem('cafe-exit-shown','1');}catch(e){}
      veil.classList.add('open');
    }
    function closeSurvey(){veil.classList.remove('open');}
    document.getElementById('exitClose').addEventListener('click',closeSurvey);
    veil.addEventListener('click',function(e){if(e.target===veil)closeSurvey();});
    document.addEventListener('mouseleave',function(e){if(e.clientY<=0)openSurvey();});
    setTimeout(function(){if(!document.hidden)openSurvey();},25000);
    function beacon(value){
      try{
        var p=JSON.stringify({kind:'barrier',value:value});
        if(navigator.sendBeacon){navigator.sendBeacon('https://cafe.tataoro.com/api/click',new Blob([p],{type:'application/json'}));}
        else{fetch('https://cafe.tataoro.com/api/click',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:p});}
      }catch(e){}
    }
    var opts=veil.querySelectorAll('.exit-opt');
    for(var i=0;i<opts.length;i++){
      opts[i].addEventListener('click',function(){
        var v=this.getAttribute('data-barrier');
        beacon(v);
        var answers=veil.querySelectorAll('.exit-answer');
        for(var j=0;j<answers.length;j++){answers[j].classList.remove('show');}
        veil.querySelector('.exit-answer[data-answer="'+v+'"]').classList.add('show');
      });
    }
    var ctas=veil.querySelectorAll('.exit-cta');
    for(var k=0;k<ctas.length;k++){
      ctas[k].addEventListener('click',function(){
        closeSurvey();
        var mode=this.getAttribute('data-cta');
        if(mode==='list'){
          try{grind.value=WB;grind.dispatchEvent(new Event('change'));}catch(e){}
          var nf=document.getElementById('notifyEmail');
          document.getElementById('buy').scrollIntoView({behavior:'smooth'});
          if(nf)setTimeout(function(){nf.focus();},600);
        }else{
          document.getElementById('buy').scrollIntoView({behavior:'smooth'});
        }
      });
    }
  })();

})();



