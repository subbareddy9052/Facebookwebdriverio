class Homepagee{
    get more() {return $("//a[@aria-label='See more Explore']")}
     get Groups() {return $("//div[text()='Groups' and @class='linkWrap noCount']")}
    get SelectPrivacy() {return $("//div[text()='Choose privacy']")}
    get Name_Group() {return $("//input[@name='name']")}
    get add_Members(){return $("//input[@placeholder='Enter names or email addresses...']")}
    get Create(){return $("//button[text()='Create Group']")}
    get addname(){
        return $("//li[@title='Nilanchal Swain']")
    }
    get addprivacy(){
        return $("//span[text()='Public']")
    }
    get Create_group(){return $("//button[text()='Create']")}

    }
    
    module.exports=new Homepagee()
